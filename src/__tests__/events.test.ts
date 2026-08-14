import { describe, expect, it } from "vitest";
import { mapUsage } from "../events.js";

describe("mapUsage", () => {
  it("subtracts cached and written tokens from prompt_tokens", () => {
    // pi-core computes promptTokens = input + cacheRead + cacheWrite, so `input`
    // must EXCLUDE both. Qoder follows OpenAI semantics where prompt_tokens
    // INCLUDES cached_tokens.
    expect(
      mapUsage({
        prompt_tokens: 42,
        completion_tokens: 7,
        total_tokens: 49,
        prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 10 },
      }),
    ).toEqual({ input: 27, output: 7, totalTokens: 49, cacheRead: 5, cacheWrite: 10 });
  });

  it("ignores cacheable_tokens, which is a capacity metric not a write count", () => {
    // cacheable_tokens is 0 even on a first-turn write, so mapping it to
    // cacheWrite would report writes that never happened.
    expect(
      mapUsage({
        prompt_tokens: 100,
        prompt_tokens_details: { cacheable_tokens: 99, cached_tokens: 0 },
      }),
    ).toEqual({ input: 100, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("treats a missing prompt_tokens_details as no cache activity", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })).toEqual({
      input: 10,
      output: 3,
      totalTokens: 13,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("defaults every absent field to zero", () => {
    expect(mapUsage({})).toEqual({ input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("never reports negative input when the cache counts exceed prompt_tokens", () => {
    // Defensive: an inconsistent upstream must not produce a negative token
    // count, which pi would render as garbage.
    expect(
      mapUsage({ prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 10 } }).input,
    ).toBe(0);
  });
});
