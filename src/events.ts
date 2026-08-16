import type {
  AssistantMessage,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { SSEFrame } from "./sse.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

/** The fields of an OpenAI-shaped `choices[0].delta` Qoder actually sends. */
export interface QoderDelta {
  reasoning_content?: string;
  /**
   * Structured reasoning: a human-readable `summary` plus, when the backend
   * withholds the reasoning itself, an opaque `encrypted_content` blob
   * (`pretty.mjs:133105-133121`).
   */
  reasoning_item?: {
    summary?: Array<{ text?: string }>;
    encrypted_content?: string;
  };
  /** Authenticates the reasoning already streamed (`pretty.mjs:133122`). */
  signature?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  /**
   * The pre-`tool_calls` OpenAI shape, still emitted by some models. Folded
   * into `tool_calls[0]` on arrival by `synthesizeLegacyFunctionCall`.
   */
  function_call?: { name?: string; arguments?: string };
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
 *
 * The key set covers the official client's whole vocabulary
 * (`pretty.mjs:132826-132845`). `end_turn` and `max_tokens` are extra: they are
 * the names the official client normalises *to*, and accepting them as input
 * costs nothing.
 */
const FINISH_REASON_TO_STOP_REASON: Record<string, "stop" | "length" | "toolUse"> = {
  stop: "stop",
  end_turn: "stop",
  length: "length",
  max_tokens: "length",
  tool_calls: "toolUse",
  function_call: "toolUse",
  // Upstream refused to continue. The official client folds both of these into
  // a single `refusal` reason (`pretty.mjs:132835-132837`); pi has no stopReason
  // for a refusal, so report the turn as finished — whatever was generated
  // before the refusal is still worth keeping.
  //
  // `refusal` is bookkeeping, not a fix: it already fell through to the default
  // branch and came out as "stop", so behaviour is unchanged. Listing it stops
  // QODER_DEBUG from crying "unmapped" about a reason the official client knows,
  // and makes the table comparable to the official vocabulary at a glance.
  content_filter: "stop",
  refusal: "stop",
};

/**
 * `finish_reason` values that are a failure, not a stop reason. Checked before
 * the table above, mirroring the official client's pre-table lookup
 * (`pretty.mjs:132821-132824`); the single entry below *is* the whole official
 * table (`pretty.mjs:132854`), status included.
 *
 * A turn whose context window overflowed is not a completed turn. Letting this
 * reason fall through to "stop" hands back a silently truncated answer that
 * looks finished, with nothing anywhere telling the user why it stopped.
 */
const FINISH_REASON_ERRORS: Record<string, { message: string; status: number }> = {
  model_context_window_exceeded: {
    message: "Qoder stopped the turn: the model context window was exceeded",
    status: 413,
  },
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

/**
 * Stand-in text for reasoning that arrived encrypted. Wording copied from pi's
 * own Anthropic adapter, so a redacted block reads the same whichever provider
 * produced it.
 */
const REDACTED_THINKING_TEXT = "[Reasoning redacted]";

/**
 * What a top-level Qoder SSE object may carry: either the HTTP envelope
 * (`statusCodeValue` + `body`, `pretty.mjs:132791`) or, when no envelope is
 * present, the chat-completion chunk itself (`pretty.mjs:132815`).
 */
interface QoderPayload {
  statusCodeValue?: unknown;
  body?: unknown;
  id?: unknown;
  model?: unknown;
  usage?: unknown;
  error?: unknown;
  choices?: Array<{ delta?: QoderDelta; finish_reason?: unknown }>;
}

/** A `[NOTIFICATIONS]` entry, narrowed to the fields Qoder's own client reads (`pretty.mjs:105214`). */
interface QoderCreditNotification {
  notificationType?: string;
  isHighestTier?: boolean;
}

/** Plain (non-array) objects only, mirroring the official record guard (`pretty.mjs:113359-113361`). */
function asObject<T = Record<string, unknown>>(value: unknown): T | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : undefined;
}

/** `pretty.mjs:113374-113377`: a finite number, or an all-digit string. */
function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** `pretty.mjs:113365-113368`: error codes are compared as trimmed strings. */
function asErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

const NOTIFICATIONS_PREFIX = "[NOTIFICATIONS]#";

/**
 * Sentinels that are protocol messages rather than payloads
 * (`pretty.mjs:132782-132786`). `[DONE]` is handled by the caller, being the
 * only one that ends the stream.
 *
 * The quota sentinels have no consumer in the official client either: its
 * sentinel test matches them and the payload parser returns null, so the event
 * is skipped. Recognising them here changes no observable behaviour — they used
 * to reach `JSON.parse`, throw SyntaxError and be skipped as "malformed" — it
 * only stops valid protocol traffic from being reported as corruption.
 */
function isSkippableSentinel(data: string): boolean {
  return data === "[NOT_EXCEED_QUOTA]" || data.startsWith("[EXCEED_QUOTA]") || data.startsWith("[NOTIFICATIONS]");
}

/**
 * The JSON behind a `[NOTIFICATIONS]#` marker, which arrives either bare or
 * wrapped in an envelope's `body` (`pretty.mjs:133060-133068`).
 */
function extractNotifications(data: string): string | undefined {
  if (data.startsWith(NOTIFICATIONS_PREFIX)) return data.slice(NOTIFICATIONS_PREFIX.length);
  if (!data.includes(NOTIFICATIONS_PREFIX)) return undefined;
  try {
    const body = asObject(JSON.parse(data))?.body;
    if (typeof body === "string" && body.startsWith(NOTIFICATIONS_PREFIX)) {
      return body.slice(NOTIFICATIONS_PREFIX.length);
    }
  } catch {}
  return undefined;
}

/** The notification types that mean the account is out of budget (`pretty.mjs:105223`). */
const TERMINAL_NOTIFICATIONS: Record<string, string> = {
  credit_exhausted: "your Qoder credits are exhausted",
  quota_exceeded: "your Qoder quota is exceeded",
};

/**
 * Surface a credit notification to the user.
 *
 * Official reports the first terminal entry, and otherwise the first
 * highest-tier one, onto its own UI event bus (`pretty.mjs:105210-105218`).
 * pi's event stream has no channel for out-of-band account state, and a
 * terminal notification means every following request fails, so it goes to the
 * console instead of being dropped.
 */
function reportCreditNotifications(payload: string): void {
  let entries: QoderCreditNotification[] | undefined;
  try {
    entries = asObject<{ notifications?: QoderCreditNotification[] }>(JSON.parse(payload))?.notifications;
  } catch {
    // A malformed notification is not a stream error (`pretty.mjs:133142-133143`).
    console.warn(`[pi-provider-qoder] failed to parse [NOTIFICATIONS] payload: ${payload.slice(0, 200)}`);
    return;
  }
  if (!entries?.length) return;

  const terminal = entries.find(
    (entry) => entry.notificationType !== undefined && TERMINAL_NOTIFICATIONS[entry.notificationType] !== undefined,
  );
  if (terminal?.notificationType !== undefined) {
    console.warn(
      `[pi-provider-qoder] Qoder reports ${TERMINAL_NOTIFICATIONS[terminal.notificationType]} ` +
        `(notificationType=${terminal.notificationType}); requests keep failing until the account is topped up.`,
    );
    return;
  }
  if (entries.some((entry) => entry.isHighestTier === true)) {
    console.warn("[pi-provider-qoder] Qoder credit warning: this account is already on its highest tier.");
    return;
  }
  if (process.env.QODER_DEBUG) {
    console.error(`[pi-provider-qoder] unreported [NOTIFICATIONS] payload: ${payload.slice(0, 200)}`);
  }
}

/**
 * The retry hints read out of an error body.
 *
 * Official classifies the body against a full error-code vocabulary reached
 * through a recursive record walk (`pretty.mjs:113392-113440`, code table at
 * `pretty.mjs:113491`) and turns it into a typed error. That classification is
 * deliberately NOT ported — it is a separate surface. Only the two codes the
 * retry booleans key off (`pretty.mjs:113452-113456`, `pretty.mjs:132798-132799`)
 * and the retry delay (`pretty.mjs:113429-113432`, `pretty.mjs:113458-113467`)
 * are read, and only from the body object and its `error` member.
 */
interface QoderErrorHints {
  retryAfterMs?: number;
  duplicateRequest: boolean;
  modelQueued: boolean;
}

const CODE_DUPLICATE_REQUEST = "103";
const CODE_MODEL_QUEUED = "10605";

function readErrorHints(bodyText: string): QoderErrorHints {
  const hints: QoderErrorHints = { duplicateRequest: false, modelQueued: false };
  // `pretty.mjs:113383-113384`: only a JSON object body carries error facts.
  if (!bodyText.trim().startsWith("{")) return hints;
  let root: Record<string, unknown> | undefined;
  try {
    root = asObject(JSON.parse(bodyText));
  } catch {
    return hints;
  }
  if (!root) return hints;

  const records = [root];
  const nested = asObject(root.error);
  if (nested) records.push(nested);
  for (const record of records) {
    const code = asErrorCode(record.code);
    if (code === CODE_DUPLICATE_REQUEST) hints.duplicateRequest = true;
    if (code === CODE_MODEL_QUEUED) hints.modelQueued = true;
    const queue = asObject(record.queue);
    if (queue?.isQueued === true) hints.modelQueued = true;
    if (hints.retryAfterMs === undefined) {
      const seconds = asFiniteNumber(record.retryAfterSeconds) ?? asFiniteNumber(queue?.retryAfterSeconds);
      hints.retryAfterMs =
        asFiniteNumber(record.retry_after_ms) ??
        asFiniteNumber(record.retryAfterMs) ??
        (seconds === undefined ? undefined : seconds * 1000);
    }
  }
  return hints;
}

/**
 * The error a non-200 envelope becomes (`pretty.mjs:132793-132805`).
 *
 * The 401 normalisation is unconditional here; official applies it only when
 * its classifier found no error code (`pretty.mjs:132800-132803`), and this
 * provider has no classifier.
 */
function upstreamEnvelopeError(envelope: QoderPayload): Error {
  const bodyText = typeof envelope.body === "string" ? envelope.body : String(envelope.body);
  const hints = readErrorHints(bodyText);
  const lowered = bodyText.toLowerCase();
  const lostLogin = lowered.includes("login expired") || lowered.includes("login timeout");
  const status = lostLogin ? 401 : asFiniteNumber(envelope.statusCodeValue);
  return Object.assign(new Error(`Qoder API error: ${String(envelope.statusCodeValue)} - ${bodyText.slice(0, 3000)}`), {
    duplicateRequest: hints.duplicateRequest,
    modelQueued: hints.modelQueued,
    ...(status === undefined ? {} : { status }),
    ...(hints.retryAfterMs === undefined ? {} : { retryAfterMs: hints.retryAfterMs }),
  });
}

export class QoderEventTranslator {
  private contentBlockIndex = -1;
  private thinkingBlockIndex = -1;
  /**
   * Index of the last plain thinking block that was *opened*. Unlike
   * `thinkingBlockIndex` it survives that block being closed, because a
   * trailing `signature` still belongs to the reasoning it authenticates even
   * once the text stream has closed the block. The official client keeps the
   * same kind of cursor and applies the signature to it
   * (`pretty.mjs:133102`, `pretty.mjs:133110`, `pretty.mjs:133122`). Redacted
   * blocks never move it: their signature slot already holds the cipher.
   */
  private signedThinkingBlockIndex = -1;
  private readonly toolCallsState: ToolCallState[] = [];
  /** Whether this turn already synthesised the opening `function_call` fragment. */
  private synthesizedFunctionCall = false;

  constructor(
    private readonly output: AssistantMessage,
    private readonly stream: AssistantMessageEventStream,
  ) {}

  /**
   * Feed one SSE event.
   *
   * Returns "done" when the terminator arrived, "continue" otherwise. A
   * malformed line is skipped (logged under QODER_DEBUG) because one bad line
   * must not kill the stream; an upstream error envelope throws, because that
   * one must reach the caller as stopReason "error".
   *
   * The whole event is taken rather than just its `data`, because the error
   * decision depends on `event:`: official exempts `event: finish` from the
   * non-200 check (`pretty.mjs:132793`), so discarding the field turned those
   * events into hard failures.
   */
  push(frame: SSEFrame): "continue" | "done" {
    // `pretty.mjs:133134-133135`: trim first, then skip an empty event.
    const data = frame.data.trim();
    if (!data) return "continue";
    if (data === "[DONE]") return "done";

    const notifications = extractNotifications(data);
    if (notifications !== undefined) {
      reportCreditNotifications(notifications);
      return "continue";
    }
    if (isSkippableSentinel(data)) return "continue";

    try {
      const top = asObject<QoderPayload>(JSON.parse(data));
      // `pretty.mjs:133150`: a payload that is not an object (`null`, a bare
      // number, an array) carries nothing to translate.
      if (!top) return "continue";

      // `pretty.mjs:132815`: with no envelope the top-level object IS the
      // payload. Requiring `body` unconditionally discarded those events —
      // every chunk of a stream that answers without the wrapper was dropped.
      let inner = top;
      // `pretty.mjs:132791`: an envelope needs BOTH fields. Testing
      // `statusCodeValue` for truthiness instead read a payload that happens
      // to carry one as an envelope, and a `statusCodeValue: 0` as none.
      if (top.statusCodeValue !== undefined && top.body !== undefined) {
        // `pretty.mjs:132793`: `event: finish` is exempt, so the closing event
        // of a stream may report a non-200 status without the turn failing.
        if (top.statusCodeValue !== 200 && frame.event !== "finish") {
          throw upstreamEnvelopeError(top);
        }
        const body = typeof top.body === "string" ? top.body.trim() : "";
        if (body === "[DONE]") {
          // Deliberate deviation: official skips this event and keeps reading
          // (`pretty.mjs:132808`). Qoder wraps the terminator as
          // `{ body: "[DONE]" }`, and nothing follows it. `continue` used to
          // leave the outer loop blocked on reader.read(), so a gateway that
          // kept the socket open held the turn for the full 300s idle timeout
          // before finishing.
          return "done";
        }
        // `pretty.mjs:132807-132808`: an empty or sentinel body is no payload.
        if (!body || isSkippableSentinel(body)) return "continue";
        const parsed = asObject<QoderPayload>(JSON.parse(body));
        if (!parsed) return "continue";
        inner = parsed;
      }

      // `pretty.mjs:133157`: an `error` field on the payload ends the turn.
      if (inner.error) {
        throw new Error(`Qoder stream returned an error payload: ${JSON.stringify(inner.error).slice(0, 500)}`);
      }
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
          console.error("[pi-provider-qoder] skipping malformed SSE line:", data.slice(0, 200));
        }
        return "continue";
      }
      throw e;
    }
  }

  private handleDelta(delta: QoderDelta): void {
    // 0. Fold a legacy `function_call` fragment into the `tool_calls` shape, so
    // the assembly path below is the only one that exists.
    this.synthesizeLegacyFunctionCall(delta);

    // 1. Process reasoning/thinking content (API reasoning)
    //
    // Three upstream channels feed the thinking block
    // (`pretty.mjs:133099-133123`): streamed `reasoning_content`, a structured
    // `reasoning_item` (summary text plus an opaque `encrypted_content`), and a
    // trailing `signature` for the reasoning already sent.
    //
    // Deliberately NOT ported: the official client also treats thinking and
    // text as a mutually exclusive pair of blocks and buffers interleaved
    // reasoning to replay or reject it later
    // (`pretty.mjs:133174-133182`). That machinery exists to keep its single
    // monotonic `content_block` index consistent; pi addresses blocks by their
    // position in `output.content`, which is fixed the moment a block is
    // pushed, so there is no numbering to preserve and nothing to replay. This
    // is a difference in event shape, not a missing feature.
    if (delta.reasoning_content) {
      this.appendThinking(delta.reasoning_content);
    }

    if (delta.reasoning_item) {
      // The summary is only streamed when this same delta carries no
      // `reasoning_content` (`pretty.mjs:133107`): it restates reasoning that
      // already went out, so emitting both would duplicate it.
      if (!delta.reasoning_content && Array.isArray(delta.reasoning_item.summary)) {
        const summary = delta.reasoning_item.summary.map((part) => part?.text ?? "").join("");
        if (summary) this.appendThinking(summary);
      }

      // `encrypted_content` is an opaque blob, not readable reasoning, so it
      // gets a block of its own (`pretty.mjs:133114-133119`). pi has no
      // separate redacted type: it carries withheld reasoning as a
      // ThinkingContent with `redacted: true` and the cipher in
      // `thinkingSignature`, so it can be handed back verbatim on the next
      // turn. Opened and closed in place — the block is complete when pushed,
      // and closing the plain block first keeps the event pairs well nested,
      // matching the official ordering (`pretty.mjs:133118`).
      const encrypted = delta.reasoning_item.encrypted_content;
      if (encrypted) {
        this.endThinkingBlock();
        const contentIndex = this.output.content.length;
        this.output.content.push({
          type: "thinking",
          thinking: REDACTED_THINKING_TEXT,
          thinkingSignature: encrypted,
          redacted: true,
        } satisfies ThinkingContent);
        this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
        this.stream.push({
          type: "thinking_end",
          contentIndex,
          content: REDACTED_THINKING_TEXT,
          partial: this.output,
        });
      }
    }

    // A signature carries no visible content, so pi has no event for it — it
    // lives on the block. Appended, not assigned, because a long signature can
    // arrive in several deltas; that is how pi's own Anthropic adapter folds
    // `signature_delta` in.
    if (delta.signature && this.signedThinkingBlockIndex !== -1) {
      const block = this.output.content[this.signedThinkingBlockIndex] as ThinkingContent;
      block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
    }

    // 2. Process text content.
    //
    // `pretty.mjs:133184-133187`: official does no tag parsing at all — `content`
    // becomes a text delta verbatim, and thinking arrives only through the three
    // structured channels above. The `ThinkingTagParser` this used to run existed
    // because the plugin inlined thinking as a literal `<thinking>…</thinking>`
    // into the assistant `content` it sent back (ledger row 24), teaching the
    // model to keep producing tags. That inlining is gone, and a live run over
    // ~20k characters of real reasoning-model output found zero literal tags
    // (`scripts/live-alignment-check.ts:"the real gateway never emits a literal
    // <thinking> tag"`), so the parser is removed rather than kept as a net that
    // would also rewrite legitimate text that merely mentions the tag.
    if (delta.content) {
      this.endThinkingBlock();

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

  /**
   * Rewrite a legacy `function_call` delta as `tool_calls[0]`, mirroring the
   * official client (`pretty.mjs:133166-133171`).
   *
   * `tool_calls` wins when both are present: a model already speaking the
   * current shape is not also asking for the legacy one to be replayed.
   *
   * Only the FIRST synthesised fragment carries id and name; later fragments
   * carry `arguments` alone, which is what makes the accumulator append to the
   * open call instead of starting a second one. Hence the per-turn flag — the
   * official client keeps the same boolean.
   *
   * The official id is `fc_${messageId}_${B}`, where `B` is the index of the
   * content block about to open. `responseId` is pi's messageId — still empty
   * when upstream never sent `id`, hence the placeholder that keeps the id well
   * formed — and `content.length` is exactly that block index. One synthesis
   * per turn means one such id per turn, so it cannot collide.
   */
  private synthesizeLegacyFunctionCall(delta: QoderDelta): void {
    const legacy = delta.function_call;
    if (!legacy || delta.tool_calls) return;

    if (this.synthesizedFunctionCall) {
      delta.tool_calls = [{ index: 0, function: { arguments: legacy.arguments } }];
    } else {
      this.synthesizedFunctionCall = true;
      const id = `fc_${this.output.responseId || "noid"}_${this.output.content.length}`;
      delta.tool_calls = [{ index: 0, id, function: legacy }];
    }
    // Dropped from the delta so no later reader can process it a second time.
    // (The official client also stamps `type: "function"` on the synthesised
    // entry; nothing here reads it, so the field is not modelled.)
    delete delta.function_call;
  }

  /** Open the shared thinking block if it is closed, then stream one chunk into it. */
  private appendThinking(chunk: string): void {
    if (this.thinkingBlockIndex === -1) {
      this.thinkingBlockIndex = this.output.content.length;
      this.signedThinkingBlockIndex = this.thinkingBlockIndex;
      this.output.content.push({ type: "thinking", thinking: "" });
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingBlockIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    block.thinking += chunk;
    this.stream.push({
      type: "thinking_delta",
      contentIndex: this.thinkingBlockIndex,
      delta: chunk,
      partial: this.output,
    });
  }

  /** Close the shared thinking block, if one is open. */
  private endThinkingBlock(): void {
    if (this.thinkingBlockIndex === -1) return;
    const block = this.output.content[this.thinkingBlockIndex] as ThinkingContent;
    this.stream.push({
      type: "thinking_end",
      contentIndex: this.thinkingBlockIndex,
      content: block.thinking,
      partial: this.output,
    });
    this.thinkingBlockIndex = -1;
  }

  /**
   * Translate one upstream `finish_reason` into pi's `stopReason`.
   *
   * Order matters: the fatal table first, then the "no termination at all"
   * values, then the vocabulary — same order as the official client
   * (`pretty.mjs:132821-132845`).
   */
  private handleFinishReason(upstream: string): void {
    const fatal = FINISH_REASON_ERRORS[upstream];
    if (fatal) {
      throw Object.assign(new Error(fatal.message), { status: fatal.status });
    }

    // The official client treats the literal string "null" exactly like a real
    // null or undefined: no termination (`pretty.mjs:132838-132841`). `push()`
    // already screens out real null/undefined, but `"null"` is truthy, so it
    // reached the table, missed, and overwrote a stop reason an earlier chunk
    // had established.
    if (upstream === "null") return;

    const mapped = FINISH_REASON_TO_STOP_REASON[upstream];
    if (mapped) {
      this.output.stopReason = mapped;
    } else {
      // Deliberate divergence: the official client throws
      // UnsupportedFinishReasonError for anything outside its vocabulary
      // (`pretty.mjs:132842-132843`). An unfamiliar but harmless reason should
      // not fail an otherwise good turn, so treat it as a completed generation
      // and keep the output. Passing it through untranslated is what produced
      // stopReason values pi silently ignored.
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
        // An empty accumulator is a no-argument tool call — the normal case,
        // not a truncation.
        let args: Record<string, unknown> = {};
        if (state.arguments) {
          const parsed = repairToolArguments(state.arguments);
          if (!parsed) {
            // Deliberately stricter than what stood here (a silent `{}`) and
            // than the official client, which also gives up to `"{}"`
            // (`pretty.mjs:132980`): running a tool with empty arguments is the
            // worst failure available — a write with no path, a search with no
            // query — and it fails invisibly. Unusable arguments end the turn.
            throw new Error(
              `Qoder tool call ${state.name || "(unnamed)"} sent arguments that are not parseable JSON, ` +
                `not even after repair (${state.arguments.length} bytes): ${state.arguments.slice(0, 200)}`,
            );
          }
          args = parsed.value;
          if (parsed.text !== state.arguments && process.env.QODER_DEBUG) {
            const suffix = parsed.text.startsWith(state.arguments) ? parsed.text.slice(state.arguments.length) : null;
            console.error(
              `[pi-provider-qoder] repaired truncated arguments for tool call ${state.id || "(no id)"}:`,
              suffix === null
                ? `dropped the trailing fragment, kept ${JSON.stringify(parsed.text.slice(-50))}`
                : `appended ${JSON.stringify(suffix)}`,
            );
          }
        }
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

/** A tool-argument string that parsed, together with the text that actually parsed. */
interface ParsedToolArguments {
  /** Differs from the accumulated arguments exactly when repair kicked in. */
  text: string;
  value: Record<string, unknown>;
}

/**
 * Repair a tool-argument string the stream cut in half, following the official
 * repair (`pretty.mjs:132940-132980`): parse as-is, else close the open
 * structures, else drop a dangling escape and close again, else drop everything
 * after the last top-level comma so the members that did arrive survive.
 *
 * Returns null when nothing parseable is left; the official client answers
 * `"{}"` there (`pretty.mjs:132980`), and `finalize` above deliberately does
 * not. The official client also re-emits the repair suffix as one more
 * `input_json_delta` (`pretty.mjs:133237-133238`); pi's event shape hands the
 * arguments over once, in `toolcall_end`, so repairing at the close is enough
 * and there is no delta to re-send.
 */
function repairToolArguments(raw: string): ParsedToolArguments | null {
  if (!raw.trim()) return { text: "{}", value: {} };

  try {
    return { text: raw, value: JSON.parse(raw) as Record<string, unknown> };
  } catch {}

  const closed = closeOpenJsonStructures(raw);
  if (closed) return closed;

  // Cut mid-escape: a trailing odd run of backslashes can never be completed,
  // so drop the orphan and close what is left of the document.
  let backslashes = 0;
  for (let i = raw.length - 1; i >= 0 && raw[i] === "\\"; i--) backslashes++;
  if (backslashes % 2 === 1) {
    const trimmed = closeOpenJsonStructures(raw.slice(0, -1));
    if (trimmed) return trimmed;
  }

  // Last resort: a half-written literal (`{"a":1,"b":tr`) cannot be closed, but
  // everything before the last top-level comma is intact.
  let lastComma = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) esc = false;
    else if (ch === "\\") {
      if (inStr) esc = true;
    } else if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === ",") lastComma = i;
  }
  if (lastComma > 0) {
    const truncated = closeOpenJsonStructures(raw.slice(0, lastComma));
    if (truncated) return truncated;
  }
  return null;
}

/**
 * Append the closers a truncated JSON document is missing, then parse it.
 * Mirrors the official close (`pretty.mjs:132982-133034`): a brace/bracket
 * stack, the quote state, and the kind of the last significant token — which is
 * what tells a cut key (`{"pa`, needs `": null` to become a member) from a cut
 * value (`{"a":"b`, needs only the quote). Brackets and quotes inside a string
 * are literal text, and an escaped quote does not end the string.
 */
function closeOpenJsonStructures(raw: string): ParsedToolArguments | null {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  let last = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        last = '"';
      }
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
        closers.push("}");
        last = "{";
        break;
      case "[":
        closers.push("]");
        last = "[";
        break;
      case "}":
        if (closers[closers.length - 1] === "}") {
          closers.pop();
          last = "}";
        }
        break;
      case "]":
        if (closers[closers.length - 1] === "]") {
          closers.pop();
          last = "]";
        }
        break;
      case ":":
      case ",":
        last = ch;
        break;
      default:
        // JSON's whitespace set; anything else is part of a value.
        if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") last = "v";
        break;
    }
  }

  let head = raw;
  let suffix = "";
  if (inString) {
    suffix = '"';
    // Cut inside an object key: closing the quote alone leaves a member with no
    // value at all, so give it one.
    if (closers[closers.length - 1] === "}" && (last === "{" || last === ",")) suffix += ": null";
  } else if (last === ":") {
    suffix = "null";
  } else if (last === ",") {
    head = head.replace(/,\s*$/, "");
  }
  for (let i = closers.length - 1; i >= 0; i--) suffix += closers[i];
  const text = head + suffix;
  try {
    return { text, value: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return null;
  }
}
