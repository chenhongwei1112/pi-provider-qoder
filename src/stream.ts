import crypto from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import {
  getMachineId,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
} from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { getCachedCredentials } from "./oauth.js";
import { qoderEncodeBodyToBuffer } from "./qoder-encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";
import { type OpenedQoderStream, openQoderStream } from "./transport.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

/**
 * Qoder speaks OpenAI's `finish_reason` vocabulary; pi's `stopReason` is a
 * closed set (`stop | length | toolUse | error | aborted`) and the `done` event
 * narrows it further to `stop | length | toolUse`.
 *
 * These are mapped explicitly because a cast is not a translation: casting
 * `finish_reason` straight into `stopReason` shipped `"tool_calls"` and
 * `"content_filter"` to pi as stopReason values it has no case for, and the
 * turn ended without output and without an error.
 */
const FINISH_REASON_TO_STOP_REASON: Record<string, "stop" | "length" | "toolUse"> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
  // Upstream refused to continue. pi has no stopReason for a content filter, so
  // report the turn as finished — whatever was generated before the refusal is
  // still worth keeping.
  content_filter: "stop",
};

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    // Declared out here so the watchdog is torn down even when the stream ends
    // through a throw: a live timer would abort a fetch nobody is reading.
    let opened: OpenedQoderStream | undefined;
    try {
      const providerMode = model.provider === "qoder-cn" ? "cn" : getQoderMode();
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          isQoderCNMode(providerMode)
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve user details from cached credentials
      const cachedCreds = getCachedCredentials(accessToken, model.provider);
      const userID = cachedCreds?.userID || "qoder-user";
      const name = cachedCreds?.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User");
      const email = cachedCreds?.email || getQoderUserEmailFallback(providerMode);
      const machineID = cachedCreds?.machineID || getMachineId();

      const qoderModel = isQoderCNMode(providerMode) ? getQoderCNDirectModel(model.id) : model.id;
      const modelConfig = getCachedModelConfig(qoderModel, providerMode) || {
        key: qoderModel,
        is_reasoning:
          qoderModel === "ultimate" ||
          qoderModel === "performance" ||
          qoderModel.includes("dmodel") ||
          qoderModel.includes("dfmodel"),
        max_output_tokens: 32768,
        source: "system",
      };
      modelConfig.key = qoderModel;

      const isReasoning = !!modelConfig.is_reasoning;
      const maxOutputTokens = modelConfig.max_output_tokens || 32768;

      const normalizedMessages = transformMessagesForQoder(context.messages);
      const systemText = context.systemPrompt || "";

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          const content = normalizedMessages[i].content;
          lastUserText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join("")
                : "";
          break;
        }
      }

      // Use a stable session id when pi provides one (per agent session) so
      // the Qoder server can maintain prompt cache affinity across consecutive
      // requests. Fall back to a random id only when no sessionId is available.
      const stablePart = stableHash("qoder-session", userID, qoderModel);
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      let maxTokens = 32768;
      if (maxOutputTokens > 0) {
        maxTokens = maxOutputTokens;
      }
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      const reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        // Qoder's server ignores the top-level `system` field (verified: the
        // model never sees it). Inject the system prompt as a leading
        // role:system message instead, which the server does honor.
        system: "",
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters: { max_tokens: maxTokens },
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: isReasoning,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: modelConfig,
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };

      const bodyBytes = Buffer.from(JSON.stringify(reqBody));
      const encodedBytes = qoderEncodeBodyToBuffer(bodyBytes);

      const chatURL = getQoderChatURL(providerMode);
      const modelSource = modelConfig.source || "system";

      opened = await openQoderStream({
        chatURL,
        encodedBytes,
        qoderModel,
        modelSource,
        callerSignal: options?.signal,
        creds: { userID, authToken: accessToken, name, email, machineID },
      });
      const { reader, armIdleWatchdog, describeStreamError } = opened;
      let pendingChunk: Uint8Array | undefined = opened.firstChunk;

      const decoder = new TextDecoder();
      let buffer = "";
      // Set when the terminator arrives, so the outer read loop stops instead of
      // waiting for the server to close the socket.
      let streamDone = false;

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState: ToolCallState[] = [];

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

      stream.push({ type: "start", partial: output });

      while (true) {
        let chunk: Uint8Array;
        if (pendingChunk) {
          chunk = pendingChunk;
          pendingChunk = undefined;
        } else {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (e) {
            throw describeStreamError(e);
          }
          if (result.done) break;
          chunk = result.value;
          armIdleWatchdog();
        }

        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) break;

          const line = buffer.substring(0, lineEnd).trim();
          buffer = buffer.substring(lineEnd + 1);

          if (!line.startsWith("data:")) continue;

          const dataStr = line.substring(5).trim();
          if (dataStr === "[DONE]") {
            streamDone = true;
            break;
          }

          try {
            const envelope = JSON.parse(dataStr);
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            if (innerStr === "[DONE]") {
              // Qoder wraps the terminator as `{ body: "[DONE]" }`, and nothing
              // follows it. `continue` used to leave the outer loop blocked on
              // reader.read(), so a gateway that kept the socket open held the
              // turn for the full 300s idle timeout before finishing.
              streamDone = true;
              break;
            }
            if (!innerStr) continue;

            const inner = JSON.parse(innerStr);
            if (inner.id) output.responseId = inner.id as string;
            if (inner.model) output.responseModel = inner.model as string;
            if (inner.usage) {
              const u = inner.usage as {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
                prompt_tokens_details?: {
                  cacheable_tokens?: number;
                  cached_tokens?: number;
                  cache_write_tokens?: number;
                };
              };
              // pi-core computes `promptTokens = input + cacheRead + cacheWrite`
              // (Anthropic convention: `input` EXCLUDES cached/written tokens).
              // Qoder follows OpenAI semantics where `prompt_tokens` INCLUDES
              // `cached_tokens`, so subtract cacheRead (and cache_write_tokens
              // when reported) to match the contract pi-ai's own OpenAI
              // provider uses. `cacheable_tokens` is a capacity metric, not a
              // write count (it is 0 even on first-turn writes), so it is NOT
              // mapped to cacheWrite.
              const promptTokens = u.prompt_tokens ?? 0;
              const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
              const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
              output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
              output.usage.output = u.completion_tokens ?? 0;
              output.usage.totalTokens = u.total_tokens ?? 0;
              output.usage.cacheRead = cacheReadTokens;
              output.usage.cacheWrite = cacheWriteTokens;
            }
            if (inner.choices && inner.choices.length > 0) {
              const choice = inner.choices[0];
              const delta = choice.delta;

              if (delta) {
                // 1. Process reasoning/thinking content (API reasoning)
                if (delta.reasoning_content) {
                  // Qoder's backend sometimes routes a literal `<thinking>`
                  // opener into reasoning_content (with the matching
                  // `</thinking>` closer landing in the content stream). Strip
                  // tag artifacts so the thinking block stays clean, matching
                  // the SDK's ContentBlock model.
                  const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                  if (reasoningChunk) {
                    if (thinkingBlockIndex === -1) {
                      thinkingBlockIndex = output.content.length;
                      output.content.push({ type: "thinking", thinking: "" });
                      stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                    }
                    const block = output.content[thinkingBlockIndex] as ThinkingContent;
                    block.thinking += reasoningChunk;
                    stream.push({
                      type: "thinking_delta",
                      contentIndex: thinkingBlockIndex,
                      delta: reasoningChunk,
                      partial: output,
                    });
                  }
                }

                // 2. Process text content
                if (delta.content) {
                  // End API thinking block if active
                  if (thinkingBlockIndex !== -1) {
                    const block = output.content[thinkingBlockIndex] as ThinkingContent;
                    stream.push({
                      type: "thinking_end",
                      contentIndex: thinkingBlockIndex,
                      content: block.thinking,
                      partial: output,
                    });
                    thinkingBlockIndex = -1;
                  }

                  if (thinkingParser) {
                    thinkingParser.processChunk(delta.content);
                  } else {
                    if (contentBlockIndex === -1) {
                      contentBlockIndex = output.content.length;
                      output.content.push({ type: "text", text: "" });
                      stream.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                    }
                    const block = output.content[contentBlockIndex] as TextContent;
                    block.text += delta.content;
                    stream.push({
                      type: "text_delta",
                      contentIndex: contentBlockIndex,
                      delta: delta.content,
                      partial: output,
                    });
                  }
                }

                // 3. Process tool calls
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsState[idx]) {
                      toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
                    }
                    const state = toolCallsState[idx];
                    if (tc.id) state.id = tc.id;
                    if (tc.function?.name) state.name = tc.function.name;

                    // Open the block as soon as the call is IDENTIFIABLE, not
                    // when its first argument byte arrives. A call whose
                    // arguments are absent or an empty string — a no-argument
                    // tool, or a model that sends id+name and then stops — used
                    // to create a toolCallsState entry and no content block, so
                    // the finalizer below saw a non-empty state array, set
                    // stopReason "toolUse", and handed back a message with no
                    // tool call in it. The agent loop then had nothing to run
                    // and the turn simply ended, mid-task and without an error.
                    if (state.emittedStart === undefined && (state.id || state.name)) {
                      state.emittedStart = true;
                      state.contentIndex = output.content.length;
                      output.content.push({
                        type: "toolCall",
                        id: state.id,
                        name: state.name,
                        arguments: {},
                      } satisfies ToolCall);
                      stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                      // Arguments that arrived before the call was identifiable
                      // were buffered rather than emitted (see below); replay
                      // them now that the block owns a contentIndex.
                      if (state.arguments) {
                        stream.push({
                          type: "toolcall_delta",
                          contentIndex: state.contentIndex,
                          delta: state.arguments,
                          partial: output,
                        });
                      }
                    }

                    // id and name can arrive after the block is open; keep it
                    // in step, since the finalizer only rewrites `arguments`.
                    if (state.emittedStart) {
                      const block = output.content[state.contentIndex] as ToolCall;
                      block.id = state.id;
                      block.name = state.name;
                    }

                    if (tc.function?.arguments) {
                      const argDelta = tc.function.arguments;
                      // Accumulate unconditionally, but only emit once the block
                      // exists. `state.contentIndex` defaults to 0, so a delta
                      // emitted before `toolcall_start` addressed whatever block
                      // happens to sit at index 0 — usually a text block.
                      const alreadyEmitted = state.emittedStart === true;
                      state.arguments += argDelta;
                      if (alreadyEmitted) {
                        stream.push({
                          type: "toolcall_delta",
                          contentIndex: state.contentIndex,
                          delta: argDelta,
                          partial: output,
                        });
                      }
                    }
                  }
                }
              }

              if (choice.finish_reason) {
                const upstream = String(choice.finish_reason);
                const mapped = FINISH_REASON_TO_STOP_REASON[upstream];
                if (mapped) {
                  output.stopReason = mapped;
                } else {
                  // An unknown reason is still a completed generation; treating
                  // it as "stop" keeps the output. Passing it through untranslated
                  // is what produced stopReason values pi silently ignored.
                  output.stopReason = "stop";
                  if (process.env.QODER_DEBUG) {
                    console.error(`[pi-provider-qoder] unmapped finish_reason ${JSON.stringify(upstream)}`);
                  }
                }
              }
            }
          } catch (e) {
            // A single malformed SSE line shouldn't kill the stream — skip it.
            // But a genuine upstream error (thrown below) must propagate to the
            // outer catch and surface as stopReason="error", not be swallowed.
            if (e instanceof SyntaxError) {
              if (process.env.QODER_DEBUG) {
                console.error("[pi-provider-qoder] skipping malformed SSE line:", dataStr.slice(0, 200));
              }
              continue;
            }
            throw e;
          }
        }
        if (streamDone) break;
      }

      if (thinkingParser) {
        thinkingParser.finalize();
      }

      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }

      for (const state of toolCallsState) {
        if (state?.emittedStart && !state.emittedEnd) {
          state.emittedEnd = true;
          let args = {};
          try {
            args = JSON.parse(state.arguments || "{}");
          } catch {}
          const block = output.content[state.contentIndex] as ToolCall;
          block.arguments = args;
          stream.push({
            type: "toolcall_end",
            contentIndex: state.contentIndex,
            toolCall: {
              type: "toolCall",
              id: state.id,
              name: state.name,
              arguments: args,
            },
            partial: output,
          });
        }
      }

      // Guarded on blocks that actually reached the message, not on the state
      // array being non-empty. Claiming "toolUse" for a message carrying no
      // tool call is what turned a malformed stream into a silent dead end.
      if (toolCallsState.some((state) => state?.emittedStart)) {
        output.stopReason = "toolUse";
      } else if (output.stopReason === "toolUse") {
        // Upstream said finish_reason=tool_calls and then never sent a call the
        // agent could run. Failing loudly beats handing pi a "toolUse" message
        // with no tool in it, which ends the turn mid-task without an error.
        throw new Error(
          "Qoder stream reported finish_reason=tool_calls but sent no usable tool call (no id or name in any delta)",
        );
      }
      // Otherwise keep whatever the upstream finish_reason mapped to; never
      // overwrite a meaningful "length" with "stop".
      stream.push({
        type: "done",
        reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
        message: output,
      });
      stream.end();
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    } finally {
      opened?.disarmWatchdog();
    }
  })();

  return stream;
}
