import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

/** The fields of an OpenAI-shaped `choices[0].delta` Qoder actually sends. */
interface QoderDelta {
  reasoning_content?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
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

/** The subset of OpenAI's `usage` object Qoder actually sends. */
export interface QoderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cacheable_tokens?: number;
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

/**
 * OpenAI `usage` → pi's usage fields.
 *
 * pi-core computes `promptTokens = input + cacheRead + cacheWrite` (Anthropic
 * convention: `input` EXCLUDES cached/written tokens). Qoder follows OpenAI
 * semantics where `prompt_tokens` INCLUDES `cached_tokens`, so both cache
 * counts are subtracted to match the contract pi-ai's own OpenAI provider uses.
 * `cacheable_tokens` is a capacity metric, not a write count (it is 0 even on
 * first-turn writes), so it is NOT mapped to cacheWrite.
 */
export function mapUsage(
  raw: QoderUsage,
): Pick<AssistantMessage["usage"], "input" | "output" | "totalTokens" | "cacheRead" | "cacheWrite"> {
  const promptTokens = raw.prompt_tokens ?? 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
    cacheRead,
    cacheWrite,
  };
}

export class QoderEventTranslator {
  private contentBlockIndex = -1;
  private thinkingBlockIndex = -1;
  private readonly toolCallsState: ToolCallState[] = [];
  private readonly thinkingParser: ThinkingTagParser | null;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
    options: { thinkingEnabled: boolean },
  ) {
    this.thinkingParser = options.thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
  }

  /**
   * Feed one SSE `data:` payload.
   *
   * Returns "done" when the terminator arrived, "continue" otherwise. A
   * malformed line is skipped (logged under QODER_DEBUG) because one bad line
   * must not kill the stream; an upstream error envelope throws, because that
   * one must reach the caller as stopReason "error".
   */
  push(payload: string): "continue" | "done" {
    if (payload === "[DONE]") return "done";

    try {
      const envelope = JSON.parse(payload);
      if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
        throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
      }

      const innerStr = envelope.body;
      if (innerStr === "[DONE]") {
        // Qoder wraps the terminator as `{ body: "[DONE]" }`, and nothing
        // follows it. `continue` used to leave the outer loop blocked on
        // reader.read(), so a gateway that kept the socket open held the
        // turn for the full 300s idle timeout before finishing.
        return "done";
      }
      if (!innerStr) return "continue";

      const inner = JSON.parse(innerStr);
      if (inner.id) this.output.responseId = inner.id as string;
      if (inner.model) this.output.responseModel = inner.model as string;
      if (inner.usage) Object.assign(this.output.usage, mapUsage(inner.usage as QoderUsage));
      if (inner.choices && inner.choices.length > 0) {
        const choice = inner.choices[0];
        if (choice.delta) this.handleDelta(choice.delta);
        if (choice.finish_reason) this.handleFinishReason(String(choice.finish_reason));
      }
      return "continue";
    } catch (e) {
      // A single malformed SSE line shouldn't kill the stream — skip it.
      // But a genuine upstream error (thrown below) must propagate to the
      // outer catch and surface as stopReason="error", not be swallowed.
      if (e instanceof SyntaxError) {
        if (process.env.QODER_DEBUG) {
          console.error("[pi-provider-qoder] skipping malformed SSE line:", payload.slice(0, 200));
        }
        return "continue";
      }
      throw e;
    }
  }

  private handleDelta(delta: QoderDelta): void {
    // 1. Process reasoning/thinking content (API reasoning)
    if (delta.reasoning_content) {
      // Qoder's backend sometimes routes a literal `<thinking>`
      // opener into reasoning_content (with the matching
      // `</thinking>` closer landing in the content stream). Strip
      // tag artifacts so the thinking block stays clean, matching
      // the SDK's ContentBlock model.
      const reasoningChunk = stripThinkingTags(delta.reasoning_content);
      if (reasoningChunk) {
        if (this.thinkingBlockIndex === -1) {
          this.thinkingBlockIndex = this.output.content.length;
          this.output.content.push({ type: "thinking", thinking: "" });
          this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
        }
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        block.thinking += reasoningChunk;
        this.stream.push({
          type: "thinking_delta",
          contentIndex: this.thinkingBlockIndex,
          delta: reasoningChunk,
          partial: this.output,
        });
      }
    }

    // 2. Process text content
    if (delta.content) {
      // End API thinking block if active
      if (this.thinkingBlockIndex !== -1) {
        const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
        this.stream.push({
          type: "thinking_end",
          contentIndex: this.thinkingBlockIndex,
          content: block.thinking,
          partial: this.output,
        });
        this.thinkingBlockIndex = -1;
      }

      if (this.thinkingParser) {
        this.thinkingParser.processChunk(delta.content);
      } else {
        if (this.contentBlockIndex === -1) {
          this.contentBlockIndex = this.output.content.length;
          this.output.content.push({ type: "text", text: "" });
          this.stream.push({ type: "text_start", contentIndex: this.contentBlockIndex, partial: this.output });
        }
        const block = this.output.content[this.contentBlockIndex] as TextContent;
        block.text += delta.content;
        this.stream.push({
          type: "text_delta",
          contentIndex: this.contentBlockIndex,
          delta: delta.content,
          partial: this.output,
        });
      }
    }

    // 3. Process tool calls
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!this.toolCallsState[idx]) {
          this.toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
        }
        const state = this.toolCallsState[idx];
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
          state.contentIndex = this.output.content.length;
          this.output.content.push({
            type: "toolCall",
            id: state.id,
            name: state.name,
            arguments: {},
          } satisfies ToolCall);
          this.stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: this.output });
          // Arguments that arrived before the call was identifiable
          // were buffered rather than emitted (see below); replay
          // them now that the block owns a contentIndex.
          if (state.arguments) {
            this.stream.push({
              type: "toolcall_delta",
              contentIndex: state.contentIndex,
              delta: state.arguments,
              partial: this.output,
            });
          }
        }

        // id and name can arrive after the block is open; keep it
        // in step, since the finalizer only rewrites `arguments`.
        if (state.emittedStart) {
          const block = this.output.content[state.contentIndex] as ToolCall;
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
            this.stream.push({
              type: "toolcall_delta",
              contentIndex: state.contentIndex,
              delta: argDelta,
              partial: this.output,
            });
          }
        }
      }
    }
  }

  private handleFinishReason(upstream: string): void {
    const mapped = FINISH_REASON_TO_STOP_REASON[upstream];
    if (mapped) {
      this.output.stopReason = mapped;
    } else {
      // An unknown reason is still a completed generation; treating
      // it as "stop" keeps the output. Passing it through untranslated
      // is what produced stopReason values pi silently ignored.
      this.output.stopReason = "stop";
      if (process.env.QODER_DEBUG) {
        console.error(`[pi-provider-qoder] unmapped finish_reason ${JSON.stringify(upstream)}`);
      }
    }
  }

  /**
   * Close open blocks, finalise tool calls, and decide the stop reason.
   * Throws when upstream promised tool_calls and sent none.
   */
  finalize(): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
    if (this.thinkingParser) {
      this.thinkingParser.finalize();
    }

    if (this.thinkingBlockIndex !== -1) {
      const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.thinkingBlockIndex,
        content: block.thinking,
        partial: this.output,
      });
    }

    for (const state of this.toolCallsState) {
      if (state?.emittedStart && !state.emittedEnd) {
        state.emittedEnd = true;
        let args = {};
        try {
          args = JSON.parse(state.arguments || "{}");
        } catch {}
        const block = this.output.content[state.contentIndex] as ToolCall;
        block.arguments = args;
        this.stream.push({
          type: "toolcall_end",
          contentIndex: state.contentIndex,
          toolCall: {
            type: "toolCall",
            id: state.id,
            name: state.name,
            arguments: args,
          },
          partial: this.output,
        });
      }
    }

    // Guarded on blocks that actually reached the message, not on the state
    // array being non-empty. Claiming "toolUse" for a message carrying no
    // tool call is what turned a malformed stream into a silent dead end.
    if (this.toolCallsState.some((state) => state?.emittedStart)) {
      this.output.stopReason = "toolUse";
    } else if (this.output.stopReason === "toolUse") {
      // Upstream said finish_reason=tool_calls and then never sent a call the
      // agent could run. Failing loudly beats handing pi a "toolUse" message
      // with no tool in it, which ends the turn mid-task without an error.
      throw new Error(
        "Qoder stream reported finish_reason=tool_calls but sent no usable tool call (no id or name in any delta)",
      );
    }
    // Otherwise keep whatever the upstream finish_reason mapped to; never
    // overwrite a meaningful "length" with "stop".
    return this.output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
  }
}
