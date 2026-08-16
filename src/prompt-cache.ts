import type { Message } from "@earendil-works/pi-ai";

/** Anthropic-style cache breakpoint marker, attached to a single content block. */
export interface CacheControl {
  type: "ephemeral";
}

/**
 * Structural view of a pi content block plus the breakpoint we stamp onto it.
 * pi's block types (TextContent | ImageContent | ThinkingContent | ToolCall) are
 * closed interfaces, so the marker cannot be expressed through them.
 */
type CacheableBlock = { type?: string; cache_control?: CacheControl };

/**
 * Block types that never receive the breakpoint, mapped from the official
 * skip set `["thinking", "redacted_thinking", "tool_use", "tool_result"]`
 * (pretty.mjs:102873) onto pi's block type names:
 *
 * - official `thinking` and `redacted_thinking` -> pi `thinking`
 *   (redaction is the `redacted` flag on ThinkingContent, not a separate type)
 * - official `tool_use` -> pi `toolCall`
 * - official `tool_result` -> pi has no such block: tool output is a whole
 *   message with role `toolResult`, handled at the message level below
 *
 * Everything else stays eligible, matching the official set: notably `image`
 * blocks are not skipped.
 */
const SKIPPED_BLOCK_TYPES: Record<string, true> = { thinking: true, toolCall: true };

/**
 * Marks the last cacheable content block of the last message with an ephemeral
 * cache breakpoint, mirroring the official client (pretty.mjs:102851-102869).
 *
 * The official function also takes a `skipCacheWrite` flag that shifts the
 * target to `length - 2`; nothing in this provider ever needs it, so only the
 * default path (always the last message) is implemented.
 *
 * Deliberately faithful and counter-intuitive: when the target message's content
 * is not an array the official code bails out entirely instead of walking back
 * to an earlier message (pretty.mjs:102856). Same for a target whose blocks are
 * all skipped. In pi terms that means a turn ending in tool output — a
 * `toolResult` message, the pi equivalent of official `tool_result` blocks —
 * carries no breakpoint at all, so only real user/assistant turns get one.
 *
 * Pure: the input array, its messages and its blocks are never mutated.
 */
export function applyPromptCacheBreakpoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const targetIndex = messages.length - 1;
  const target = messages[targetIndex];
  if (target === undefined) return messages;

  // Official: every block of a `tool_result`-only user message is skipped.
  if (target.role === "toolResult") return messages;

  const content: unknown = target.content;
  if (!Array.isArray(content)) return messages;

  const blocks = content as CacheableBlock[];
  let blockIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i]?.type;
    // A block without a type is skipped, matching the official `Q?.type &&` guard.
    if (type && SKIPPED_BLOCK_TYPES[type] !== true) {
      blockIndex = i;
      break;
    }
  }
  if (blockIndex === -1) return messages;

  const nextBlocks = [...blocks];
  nextBlocks[blockIndex] = { ...nextBlocks[blockIndex], cache_control: { type: "ephemeral" } };

  const next = [...messages];
  next[targetIndex] = { ...target, content: nextBlocks } as Message;
  return next;
}
