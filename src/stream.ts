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
  buildAuthHeaders,
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

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

/**
 * Transport budget, mirroring the `infer-sse` contract in Qoder's own CLI:
 * 3 attempts, and a 60s ceiling on the first payload. The idle ceiling matches
 * its default `stream_idle_timeout_ms`.
 */
const MAX_SEND_ATTEMPTS = 3;
const FIRST_PAYLOAD_TIMEOUT_MS = 60_000;
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Connection-level faults Qoder's CLI retries. `fetch failed` is undici's
 * opaque wrapper: it is what a request gets when the pooled keep-alive socket
 * was closed by the gateway before the write, which happens routinely once a
 * turn spends longer in tool calls than undici's 4s keep-alive window.
 */
const RETRYABLE_ERROR_CODES: Record<string, true> = {
  UND_ERR_SOCKET: true,
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  ECONNREFUSED: true,
  EAI_AGAIN: true,
  ENOTFOUND: true,
  EPROTO: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

/** Retryable HTTP statuses: transient gateway faults and rate limits. */
const RETRYABLE_STATUSES: Record<number, true> = {
  408: true,
  425: true,
  429: true,
  500: true,
  502: true,
  503: true,
  504: true,
};

/** Error messages undici raises for a connection that died under us. */
const RETRYABLE_ERROR_MESSAGES: Record<string, true> = {
  "fetch failed": true,
  "other side closed": true,
  "socket hang up": true,
  terminated: true,
};

interface ErrorLink {
  name?: string;
  code?: string;
  message: string;
}

/** The error chain as `{ name, code, message }` triples, outermost first. */
function errorChain(error: unknown): ErrorLink[] {
  const chain: ErrorLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const link: ErrorLink = { message: "" };
    if ("name" in current && typeof current.name === "string") link.name = current.name;
    if ("code" in current && typeof current.code === "string") link.code = current.code;
    if ("message" in current) link.message = typeof current.message === "string" ? current.message : "";
    chain.push(link);
    current = "cause" in current ? current.cause : undefined;
  }
  if (chain.length === 0) chain.push({ message: String(error) });
  return chain;
}

function isRetryableTransportError(error: unknown): boolean {
  return errorChain(error).some(
    (link) =>
      (link.code !== undefined && RETRYABLE_ERROR_CODES[link.code] === true) ||
      link.name === "ConnectTimeoutError" ||
      RETRYABLE_ERROR_MESSAGES[link.message] === true,
  );
}

/**
 * Flatten the cause chain into the message. `fetch failed` on its own says
 * nothing; the `cause` carries the actual syscall or undici code.
 */
function formatTransportError(error: unknown): Error {
  const chain = errorChain(error);
  const detail = chain
    .slice(1)
    .map((link) => `${link.name ?? "Error"}${link.code ? `(${link.code})` : ""}: ${link.message}`)
    .join(" <- ");
  const head = chain[0]?.message ?? String(error);
  const formatted = new Error(detail ? `${head} (${detail})` : head);
  formatted.cause = error;
  return formatted;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Executor form: `Promise.withResolvers` needs ES2024/Node 22, and this
  // extension still has to load on the Node 20 baseline pi supports.
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface OpenStreamRequest {
  chatURL: string;
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  callerSignal?: AbortSignal;
  creds: { userID: string; authToken: string; name: string; email: string; machineID: string };
}

interface OpenedQoderStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** First chunk, already consumed from the reader to prove the stream is live. */
  firstChunk: Uint8Array;
  armIdleWatchdog: () => void;
  disarmWatchdog: () => void;
  /** Turn a mid-stream read failure into a message that names the real cause. */
  describeStreamError: (error: unknown) => Error;
}

/**
 * POST the chat request and return the stream once its first byte has arrived.
 *
 * Everything that can fail before that first byte — connect, TLS, request
 * write, response headers, first payload — is retried with exponential backoff,
 * because none of it can have produced model output yet. `request_id` is reused
 * across attempts so the gateway can recognise a retry of the same turn.
 */
async function openQoderStream(request: OpenStreamRequest): Promise<OpenedQoderStream> {
  const { chatURL, encodedBytes, qoderModel, modelSource, callerSignal, creds } = request;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("Aborted");

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let timedOutAfterMs: number | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOutAfterMs = ms;
        controller.abort();
      }, ms);
      watchdog.unref?.();
    };
    const disarmWatchdog = () => {
      clearTimeout(watchdog);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const describeStreamError = (error: unknown): Error => {
      if (timedOutAfterMs !== undefined) {
        return new Error(`Qoder stream stalled: no data for ${Math.round(timedOutAfterMs / 1000)}s`);
      }
      if (callerSignal?.aborted) return error instanceof Error ? error : new Error(String(error));
      return formatTransportError(error);
    };

    // The clock starts at the request, not at the response headers: a stalled
    // gateway must not hold the turn open forever.
    arm(FIRST_PAYLOAD_TIMEOUT_MS);

    try {
      // Rebuilt per attempt: the COSY signature covers a timestamp.
      const headers = buildAuthHeaders(encodedBytes, chatURL, creds);
      const response = await fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": qoderModel,
          "X-Model-Source": modelSource,
          ...headers,
        },
        body: encodedBytes,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw Object.assign(
          new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`),
          { status: response.status },
        );
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const first = await reader.read();
      if (first.done) throw new Error("Qoder stream closed before sending any data");
      arm(STREAM_IDLE_TIMEOUT_MS);

      return {
        reader,
        firstChunk: first.value,
        armIdleWatchdog: () => arm(STREAM_IDLE_TIMEOUT_MS),
        disarmWatchdog,
        describeStreamError,
      };
    } catch (e) {
      disarmWatchdog();
      if (callerSignal?.aborted) throw e;

      const status = e && typeof e === "object" && "status" in e && typeof e.status === "number" ? e.status : undefined;
      const retryable =
        timedOutAfterMs !== undefined ||
        (status !== undefined ? RETRYABLE_STATUSES[status] === true : isRetryableTransportError(e));
      lastError = timedOutAfterMs !== undefined ? describeStreamError(e) : e;
      if (!retryable || attempt === MAX_SEND_ATTEMPTS) break;

      const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      const jittered = Math.max(0, delay + delay * 0.3 * (Math.random() * 2 - 1));
      if (process.env.QODER_DEBUG) {
        console.error(
          `[pi-provider-qoder] attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed (${
            lastError instanceof Error ? lastError.message : String(lastError)
          }); retrying in ${Math.round(jittered)}ms`,
        );
      }
      await sleep(jittered, callerSignal);
    }
  }

  throw formatTransportError(lastError);
}

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
            break;
          }

          try {
            const envelope = JSON.parse(dataStr);
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            if (!innerStr || innerStr === "[DONE]") continue;

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
                      state.arguments += argDelta;
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

              if (choice.finish_reason) {
                // Preserve the real upstream finish_reason (e.g. "length",
                // "content_filter") instead of forcing "stop" later.
                output.stopReason = choice.finish_reason as AssistantMessage["stopReason"];
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
      }
      // Otherwise keep whatever finish_reason set upstream (defaults to "stop").
      // Never overwrite a meaningful finish_reason ("length", "content_filter",
      // ...) with "stop".
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
