import crypto from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getQoderChatURL, getQoderCNDirectModel, isQoderCNMode, type QoderIdentity } from "./cosy.js";
import { getCachedModelConfig, thinkingFor } from "./models.js";
import { applyPromptCacheBreakpoint } from "./prompt-cache.js";
import { qoderEncodeBodyToBuffer } from "./qoder-encoding.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";

/** First 16 hex chars of sha256 over a domain prefix plus NUL-separated parts. */
export function stableID(prefix: string, parts: Iterable<string>): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Stable id for one chat turn, wire-visible as `request_set_id`/`chat_record_id`.
 *
 * The parts are collected in the exact order the id has always hashed them, so
 * the hex stays byte-identical: model, then each message's role and content
 * (each skipped when falsy), then the tools JSON whenever `tools` is truthy at
 * all — an empty array included — then the token cap.
 */
export function chatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const parts: string[] = [model];
  for (const msg of messages) {
    if (msg?.role) parts.push(msg.role);
    if (msg?.content) parts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
  }
  if (tools) parts.push(JSON.stringify(tools));
  parts.push(`mt=${maxTokens}`);
  return stableID("qoder-record", parts);
}

export interface QoderChatRequest {
  encodedBytes: Buffer<ArrayBuffer>;
  qoderModel: string;
  modelSource: string;
  chatURL: string;
}

/**
 * The official reasoning effort vocabulary (`pretty.mjs:85158-85166`), minus
 * `none`, which arrives through the disable path rather than as an effort.
 */
const REASONING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Build the `parameters` object of a chat request.
 *
 * Mirrors the official gateway path: `parameters` starts out empty, `max_tokens`
 * is written first (`pretty.mjs:132110-132111`), then the reasoning keys are
 * patched in (`pretty.mjs:132112-132118`). This is the carrier the server reads:
 * `model_config.thinking_config` and `chat_context.extra.modelConfig.thinking_effort`
 * are not part of the official body at all, so an effort shaped into either of
 * them is silently dropped.
 *
 * The official builder can also carry `temperature` / `top_p` / `top_k` /
 * `preserve_thinking` / `context_length` / `tool_choice`
 * (`pretty.mjs:121989-122005`, `pretty.mjs:132120-132121`), but only once the
 * caller configured a generation preference; omp exposes none of those knobs, so
 * the default path here is the official default path. `reasoning_budget_tokens`
 * is likewise written only for a positive explicit thinking budget
 * (`pretty.mjs:132116`) -- omp has no such input, so that condition can never
 * hold and its absence is alignment, not an omission.
 */
export function buildChatParameters(args: {
  maxTokens: number;
  /** A value from the official effort vocabulary, or undefined when unrequested. */
  reasoningEffort?: string;
  /** The caller asked for thinking to be off. */
  thinkingDisabled: boolean;
}): Record<string, unknown> {
  const { maxTokens, reasoningEffort, thinkingDisabled } = args;
  const parameters: Record<string, unknown> = { max_tokens: maxTokens };
  if (thinkingDisabled || reasoningEffort === "none") {
    // `pretty.mjs:132115`: effort `none` pins `enable_thinking` to false and
    // drops any budget key.
    parameters.reasoning_effort = "none";
    parameters.enable_thinking = false;
  } else if (reasoningEffort) {
    parameters.reasoning_effort = reasoningEffort;
    parameters.enable_thinking = true;
  }
  return parameters;
}

/**
 * `pretty.mjs:132119`: a turn that switches thinking off also reports
 * `model_config.is_reasoning: false`, whatever the catalog entry claims.
 */
export function effectiveIsReasoning(
  catalogIsReasoning: boolean,
  thinkingDisabled: boolean,
  reasoningEffort?: string,
): boolean {
  if (thinkingDisabled || reasoningEffort === "none") return false;
  return catalogIsReasoning;
}

/** Cap qodercli falls back to when a model's `max_output_tokens` is unusable (`pretty.mjs:105460`). */
const QODER_DEFAULT_MAX_TOKENS = 32000;

/** Context window qodercli falls back to when a catalog entry has none (`pretty.mjs:132131`). */
const QODER_DEFAULT_MAX_INPUT_TOKENS = 200000;

/**
 * Screen a cached `max_output_tokens` down to a usable cap, matching the
 * official helper (`pretty.mjs:105458-105460`): a number is taken as is, a
 * non-blank string is parsed, anything else becomes NaN; the result is kept only
 * when it is a positive safe integer, otherwise the cap falls back to 32000.
 *
 * Both halves are load-bearing. The value comes from getCachedModelConfig,
 * which hands back `data.configs[key]` verbatim from the on-disk cache
 * (`models.ts:52-62`), and updateQoderModelsCache persists whatever the server
 * sent (`models.ts:188`), so a negative or corrupted value is reachable. A
 * plain `value || 32000` would not catch one: a negative number is truthy, so
 * it would go out as `max_tokens: -1` and be hashed into `request_set_id` as
 * `mt=-1`.
 */
export function clampMaxTokens(value: unknown): number {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim().length > 0) n = Number(value);
  else n = Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : QODER_DEFAULT_MAX_TOKENS;
}

/**
 * Build the fixed ten-key `model_config` the official client sends
 * (`pretty.mjs:132131`).
 *
 * Every field is either read off the catalog entry or defaulted, so entry fields
 * the server ships now or later (`thinking_config`, `server_scene`, ...) cannot
 * ride back onto the wire the way handing the cached entry over did.
 * `is_reasoning` is a parameter because the thinking switches decide it
 * (`pretty.mjs:132119`), outside this function.
 *
 * The official BYOK / `custom_model` branches (`pretty.mjs:132132-132138`) are
 * not ported: omp has no BYOK path, so the entry is always a service model.
 */
export function buildModelConfig(
  entry: Record<string, unknown> | null | undefined,
  modelID: string,
  isReasoning: boolean,
): Record<string, unknown> {
  const key = entry?.key ?? modelID;
  return {
    key,
    display_name: entry?.display_name ?? key,
    model: "",
    format: entry?.format ?? "openai",
    is_vl: entry?.is_vl ?? false,
    is_reasoning: isReasoning,
    api_key: "",
    url: "",
    source: entry?.source ?? "system",
    max_input_tokens: entry?.max_input_tokens ?? QODER_DEFAULT_MAX_INPUT_TOKENS,
  };
}

/**
 * Build the chat request body and everything the transport needs to send it.
 *
 * Pure with respect to the network: it reads the model cache and hashes the
 * conversation, but performs no I/O beyond that cache read.
 */
export function buildChatRequest(args: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  providerMode: string;
  identity: QoderIdentity;
}): QoderChatRequest {
  const { model, context, options, providerMode, identity } = args;

  const qoderModel = isQoderCNMode(providerMode) ? getQoderCNDirectModel(model.id) : model.id;
  const modelConfig = getCachedModelConfig(qoderModel, providerMode) || {
    key: qoderModel,
    is_reasoning:
      qoderModel === "ultimate" ||
      qoderModel === "performance" ||
      qoderModel.includes("dmodel") ||
      qoderModel.includes("dfmodel"),
    max_output_tokens: QODER_DEFAULT_MAX_TOKENS,
    source: "system",
  };
  modelConfig.key = qoderModel;

  const maxOutputTokens = clampMaxTokens(modelConfig.max_output_tokens);
  // Map omp's thinking option onto the official effort vocabulary
  // (`pretty.mjs:85158-85166`). Two signals arrive: the current harness sends
  // `--thinking off` as `disableReasoning: true` with `reasoning` unset, while
  // the declared `SimpleStreamOptions` still admits the narrower path where
  // `reasoning` itself carries "off"/"none"/false. Both are honored. The
  // declared `ThinkingLevel` is also narrower than what actually arrives --
  // "max" is outside the declared union too -- so the option is read as
  // `unknown` and the tokens are matched as data.
  //
  // The level is then checked against the model's own effort rungs from the
  // catalog's `thinking_config.enabled.efforts`. omp's fork only offers the
  // catalog's tokens, so menu picks ride through unchanged; the check screens
  // raw tokens the fork would never pick: `minimal` snaps onto the lowest rung,
  // `xhigh` onto the highest, and a level with no rung at all falls back to
  // the official default path -- no reasoning keys in `parameters` whatsoever.
  // No catalog info at all (cache miss) keeps the pre-catalog pass-through.
  const rungs = thinkingFor(modelConfig)?.efforts;
  const reasoningVal: unknown = options?.reasoning;
  const disableVal: unknown = (options as { disableReasoning?: unknown } | undefined)?.disableReasoning;
  const thinkingDisabled =
    disableVal === true || reasoningVal === false || reasoningVal === "off" || reasoningVal === "none";
  let thinkingEffort: string | undefined;
  if (!thinkingDisabled && typeof reasoningVal === "string") {
    if (reasoningVal === "minimal") thinkingEffort = rungs?.[0] ?? "low";
    else if (REASONING_EFFORTS.includes(reasoningVal)) {
      if (!rungs || rungs.includes(reasoningVal)) thinkingEffort = reasoningVal;
      else if (reasoningVal === "xhigh") thinkingEffort = rungs[rungs.length - 1];
    }
  }
  const isReasoning = effectiveIsReasoning(!!modelConfig.is_reasoning, thinkingDisabled, thinkingEffort);

  // `pretty.mjs:112274`: official marks the prompt cache breakpoint on the
  // pi-shaped array BEFORE the per-role transform, so the marker rides along
  // into the transformed `contents` entries (ledger row 25).
  const normalizedMessages = transformMessagesForQoder(applyPromptCacheBreakpoint(context.messages));
  // omp hands `systemPrompt` over as an array of prompt segments, while the
  // `pi-ai` types omp injects into extensions still declare it as `string`.
  // Measured as an array under the default prompt, `--system-prompt`, and
  // `--append-system-prompt`; the string branch stays as a zero-cost guard
  // because the declared type permits it. Passing the array straight through as
  // a system message's `content` makes Qoder reject the body with
  // "set property error, ...MessagesInputDto#content".
  const systemText = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n\n")
    : context.systemPrompt || "";

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
  const stablePart = stableID("qoder-session", [identity.userID, qoderModel]);
  const sessionID = options?.sessionId ? `${stablePart}-${options.sessionId}` : `${stablePart}-${crypto.randomUUID()}`;

  // clampMaxTokens already screened the cached cap, so only a smaller caller cap
  // can still lower it.
  let maxTokens = maxOutputTokens;
  if (options?.maxTokens && options.maxTokens < maxTokens) {
    maxTokens = options.maxTokens;
  }

  const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
  const recordID = chatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

  // Key order is the official one (`pretty.mjs:132123`). It is load-bearing:
  // the COSY signature covers the encoded body, so `JSON.stringify`'s insertion
  // order is part of the signed bytes. `chat_context` sits 7th and `model_config`
  // 16th here, not last as they used to (ledger row 16).
  //
  // Official also has `custom_model` (16th) and a conditional `patches`; both are
  // BYOK/edit-mode only and `undefined` on this path, where `JSON.stringify`
  // drops them, so omitting them is wire-equivalent (ledger row 111).
  const reqBody: Record<string, unknown> = {
    request_id: crypto.randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      // `pretty.mjs:132178`. `text` and `originalContent` carry the same value.
      text: lastUserText,
      features: [],
      extra: {
        context: [],
        // Exactly two keys. The `thinking_effort` this used to add does not
        // exist anywhere in the official bundle (ledger row 21); reasoning
        // effort travels in `parameters` instead.
        modelConfig: {
          key: qoderModel,
          is_reasoning: isReasoning,
        },
        originalContent: lastUserText,
      },
      chatPrompt: "",
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    agent_id: "agent_common",
    task_id: "common",
    session_type: "qodercli",
    aliyun_user_type: "",
    model_config: buildModelConfig(modelConfig, qoderModel, isReasoning),
    // Official sends the prompt in BOTH places: the top-level field and a
    // leading system message (`pretty.mjs:132108` + `pretty.mjs:132123`). The
    // old comment here claimed the server ignores the top-level field, which is
    // true but beside the point — a request whose `system` is empty while
    // `messages[0].role === "system"` is a distinguishable client fingerprint
    // (ledger row 18).
    system: systemText,
    messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
    tools: toolsRaw || [],
    parameters: buildChatParameters({ maxTokens, reasoningEffort: thinkingEffort, thinkingDisabled }),
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

  return { encodedBytes, qoderModel, modelSource, chatURL };
}
