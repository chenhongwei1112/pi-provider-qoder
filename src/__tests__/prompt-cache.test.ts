import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyPromptCacheBreakpoint } from "../prompt-cache.js";

/** The blocks of message `index`, viewed structurally so `cache_control` is readable. */
function blocksOf(messages: Message[], index: number): Array<Record<string, unknown>> {
  const message = messages[index];
  if (message === undefined) throw new Error(`no message at index ${index}`);
  const content = message.content;
  if (!Array.isArray(content)) throw new Error(`message ${index} has string content`);
  // pi's block interfaces have no index signature and cannot carry cache_control.
  const blocks = content as unknown as Array<Record<string, unknown>>;
  return blocks;
}

const EPHEMERAL = { type: "ephemeral" };

describe("applyPromptCacheBreakpoint", () => {
  it("returns an empty array unchanged", () => {
    const messages: Message[] = [];
    expect(applyPromptCacheBreakpoint(messages)).toBe(messages);
  });

  it("marks the last text block of the last user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "old" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "text", text: "third" },
        ],
      },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(blocksOf(out, 1).map((b) => b.cache_control)).toEqual([undefined, undefined, EPHEMERAL]);
    // Earlier messages never get a breakpoint.
    expect(blocksOf(out, 0)[0]?.cache_control).toBeUndefined();
    expect(out[0]).toBe(messages[0]);
  });

  it("marks a single message's only block", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "solo" }] }] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(blocksOf(out, 0)[0]).toEqual({ type: "text", text: "solo", cache_control: EPHEMERAL });
  });

  it("skips trailing thinking and toolCall blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
      },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(blocksOf(out, 0).map((b) => b.cache_control)).toEqual([EPHEMERAL, undefined, undefined]);
  });

  it("marks image blocks, which the official skip set does not cover", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(blocksOf(out, 0).map((b) => b.cache_control)).toEqual([undefined, EPHEMERAL]);
  });

  it("marks nothing when the last message has string content, even if earlier ones qualify", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "eligible" }] },
      { role: "user", content: "plain string" },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(out).toBe(messages);
    expect(blocksOf(messages, 0)[0]?.cache_control).toBeUndefined();
  });

  it("marks nothing when the last message is a toolResult", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "eligible" }] },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "output" }] },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(out).toBe(messages);
    expect(blocksOf(messages, 1)[0]?.cache_control).toBeUndefined();
  });

  it("marks nothing when the last message holds only thinking and toolCall blocks", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "eligible" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
        ],
      },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(out).toBe(messages);
  });

  it("marks nothing when the last message has an empty block array", () => {
    const messages = [{ role: "assistant", content: [] }] as unknown as Message[];

    expect(applyPromptCacheBreakpoint(messages)).toBe(messages);
  });

  it("skips blocks without a type field", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "typed" }, { text: "untyped" }],
      },
    ] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(blocksOf(out, 0).map((b) => b.cache_control)).toEqual([EPHEMERAL, undefined]);
  });

  it("never mutates the input array, message or block", () => {
    const block = { type: "text", text: "hello" };
    const message = { role: "user", content: [block] };
    const messages = [message] as unknown as Message[];

    const out = applyPromptCacheBreakpoint(messages);

    expect(out).not.toBe(messages);
    expect(out[0]).not.toBe(messages[0]);
    expect(blocksOf(out, 0)).not.toBe(message.content);
    expect(blocksOf(out, 0)[0]).not.toBe(block);
    expect(block).toEqual({ type: "text", text: "hello" });
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });
});
