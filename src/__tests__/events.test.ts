import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { mapUsage, type QoderDelta, QoderEventTranslator } from "../events.js";
import type { SSEFrame } from "../sse.js";

/**
 * A translator whose `output` starts at `initialStopReason`, plus handles that
 * feed it one upstream `finish_reason` (`finish`) or one `choices[0].delta`
 * (`delta`), and the `events` the translator pushed downstream.
 *
 * The handles reach the private methods on purpose: the finish_reason
 * vocabulary and the delta channels are contracts of their own, and driving
 * them through `push()` would tie these cases to the SSE frame and envelope
 * shapes, which stream.test.ts already covers end to end.
 */
function makeTranslator(initialStopReason: AssistantMessage["stopReason"] = "stop") {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
    provider: "qoder",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: initialStopReason,
    timestamp: 0,
  };
  const events: AssistantMessageEvent[] = [];
  const stream = {
    push: (event: AssistantMessageEvent) => {
      events.push(event);
    },
    end: () => {},
    [Symbol.asyncIterator]: function* () {},
  } as unknown as AssistantMessageEventStream;
  const translator = new QoderEventTranslator(output, stream);
  return {
    output,
    events,
    finish: (reason: string) => translator["handleFinishReason"](reason),
    delta: (payload: QoderDelta) => translator["handleDelta"](payload),
    push: (frame: SSEFrame) => translator.push(frame),
    finalize: () => translator.finalize(),
  };
}

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

describe("finish_reason translation", () => {
  it.each([
    ["stop", "stop"],
    ["end_turn", "stop"],
    ["length", "length"],
    ["max_tokens", "length"],
    ["tool_calls", "toolUse"],
    ["function_call", "toolUse"],
    // pi has no stopReason for a refusal, so both official refusal reasons land
    // on "stop" and keep whatever was generated before the refusal.
    ["content_filter", "stop"],
    ["refusal", "stop"],
  ] as const)("translates finish_reason %s into stopReason %s", (upstream, expected) => {
    // Starts at "error" so a mapping that silently fails to write is caught.
    const { finish, output } = makeTranslator("error");
    finish(upstream);
    expect(output.stopReason).toBe(expected);
  });

  it("fails the turn with status 413 when upstream reports a context window overflow", () => {
    // Mapping this to "stop" is the worst possible outcome: the answer is
    // truncated, the turn looks completed, and nothing tells the user why.
    const { finish } = makeTranslator();
    let thrown: unknown;
    try {
      finish("model_context_window_exceeded");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { status?: number }).status).toBe(413);
    expect((thrown as Error).message).toMatch(/context window/i);
  });

  it('treats the literal string "null" as no termination at all', () => {
    // "null" is truthy, so it used to reach the mapping table, miss, and clobber
    // the stop reason an earlier chunk had already established.
    const { finish, output } = makeTranslator("length");
    finish("null");
    expect(output.stopReason).toBe("length");
  });

  it("keeps an unfamiliar finish_reason non-fatal and reports the turn as finished", () => {
    const { finish, output } = makeTranslator("length");
    expect(() => finish("wat")).not.toThrow();
    expect(output.stopReason).toBe("stop");
  });

  it("never reports a finish_reason the official client knows as unmapped", () => {
    // `refusal` comes out as "stop" whether or not it is in the table, so this
    // debug line is the only observable difference: a member of the official
    // vocabulary must not be reported as something the provider cannot
    // translate.
    const previous = process.env.QODER_DEBUG;
    process.env.QODER_DEBUG = "1";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { finish, output } = makeTranslator();
      finish("refusal");
      expect(output.stopReason).toBe("stop");
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      if (previous === undefined) delete process.env.QODER_DEBUG;
      else process.env.QODER_DEBUG = previous;
    }
  });
});

describe("reasoning channels", () => {
  const thinkingBlocks = (output: AssistantMessage) =>
    output.content.filter((block): block is ThinkingContent => block.type === "thinking");

  it("streams every reasoning_item summary entry, in order, into one thinking block", () => {
    const { delta, output, events } = makeTranslator();
    delta({ reasoning_item: { summary: [{ text: "weighing " }, { text: "the options" }] } });

    expect(thinkingBlocks(output)).toEqual([{ type: "thinking", thinking: "weighing the options" }]);
    expect(events.filter((e) => e.type === "thinking_start")).toHaveLength(1);
    const streamed = events.flatMap((e) => (e.type === "thinking_delta" ? [e.delta] : []));
    expect(streamed).toEqual(["weighing the options"]);
  });

  it("carries reasoning_item.encrypted_content as a redacted thinking block", () => {
    // The cipher is the only thing that makes the reasoning replayable on the
    // next turn, so it has to survive verbatim, and the block has to be marked
    // redacted or its placeholder text would be sent back as real reasoning.
    const { delta, output, events } = makeTranslator();
    delta({ reasoning_item: { encrypted_content: "OPAQUE-CIPHER" } });

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: "OPAQUE-CIPHER",
      redacted: true,
    });
    // Self-contained: the block is opened and closed by the delta that carries
    // it, so finalize() has nothing left to close.
    expect(events.map((e) => e.type)).toEqual(["thinking_start", "thinking_end"]);
  });

  it("never routes later reasoning into the redacted block", () => {
    // Appending to the redacted block would both corrupt the cipher's block and
    // hide the reasoning inside something renderers show as withheld.
    const { delta, output } = makeTranslator();
    delta({ reasoning_content: "before" });
    delta({ reasoning_item: { encrypted_content: "CIPHER" } });
    delta({ reasoning_content: "after" });

    const blocks = thinkingBlocks(output);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "before" });
    expect(blocks[1]).toMatchObject({ redacted: true, thinkingSignature: "CIPHER" });
    expect(blocks[2]).toEqual({ type: "thinking", thinking: "after" });
  });

  it("attaches a signature to the thinking block it authenticates", () => {
    const { delta, output } = makeTranslator();
    delta({ reasoning_content: "reasoned" });
    delta({ signature: "SIG" });

    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "reasoned", thinkingSignature: "SIG" });
  });

  it("still attaches a signature that arrives after text closed the thinking block", () => {
    // Upstream sends the signature last; by then the first content chunk has
    // already closed the thinking block. Dropping it there would strip the
    // signature off every reasoning block that is followed by an answer.
    const { delta, output } = makeTranslator();
    delta({ reasoning_content: "reasoned" });
    delta({ content: "the answer" });
    delta({ signature: "SIG" });

    expect(output.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "SIG" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "the answer" });
  });

  it("ignores a signature that arrives before any reasoning", () => {
    const { delta, output } = makeTranslator();
    expect(() => delta({ signature: "SIG" })).not.toThrow();
    expect(output.content).toEqual([]);
  });

  it("keeps mixed reasoning_content and reasoning_item in a single thinking block", () => {
    const { delta, output, events } = makeTranslator();
    delta({ reasoning_content: "first " });
    delta({ reasoning_item: { summary: [{ text: "second" }] } });

    expect(thinkingBlocks(output)).toEqual([{ type: "thinking", thinking: "first second" }]);
    expect(events.filter((e) => e.type === "thinking_start")).toHaveLength(1);
  });

  it("does not emit the summary twice when one delta carries both reasoning channels", () => {
    // The summary restates what reasoning_content already streamed, so the
    // official client skips it whenever both arrive together
    // (`pretty.mjs:133107`).
    const { delta, output } = makeTranslator();
    delta({ reasoning_content: "streamed", reasoning_item: { summary: [{ text: "streamed" }] } });

    expect(thinkingBlocks(output)).toEqual([{ type: "thinking", thinking: "streamed" }]);
  });

  const emptyItems: Array<[string, NonNullable<QoderDelta["reasoning_item"]>]> = [
    ["an empty reasoning_item", {}],
    ["an empty summary array", { summary: [] }],
    ["a summary entry with no text", { summary: [{}] }],
    ["an empty encrypted_content", { encrypted_content: "" }],
  ];

  it.each(emptyItems)("opens no block for %s", (_label, reasoning_item) => {
    const { delta, output, events } = makeTranslator();
    expect(() => delta({ reasoning_item })).not.toThrow();
    expect(output.content).toEqual([]);
    expect(events).toEqual([]);
  });
});

/**
 * 台账差异第 37 行：a legacy `function_call` delta is rewritten as `tool_calls[0]`
 * so it reaches the agent loop as a runnable call (`pretty.mjs:133166-133171`).
 */
describe("legacy function_call fragments", () => {
  it("synthesizes a runnable tool call from function_call alone", () => {
    const { delta, finalize, output } = makeTranslator();
    delta({ function_call: { name: "read_file", arguments: '{"path":"/tmp/a"}' } });

    expect(finalize()).toBe("toolUse");
    expect(output.content).toEqual([
      // The id has to be non-empty: pi matches the tool result back to the call by it.
      { type: "toolCall", id: expect.stringMatching(/^fc_.+/), name: "read_file", arguments: { path: "/tmp/a" } },
    ]);
  });

  it("appends later function_call fragments to the same tool call", () => {
    const { delta, finalize, output } = makeTranslator();
    delta({ function_call: { name: "write_file", arguments: '{"path":' } });
    delta({ function_call: { arguments: '"/tmp/a","body":"hi"}' } });

    expect(finalize()).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^fc_.+/),
        name: "write_file",
        arguments: { path: "/tmp/a", body: "hi" },
      },
    ]);
  });

  it("leaves tool_calls in charge when a delta carries both shapes", () => {
    const { delta, finalize, output } = makeTranslator();
    delta({
      function_call: { name: "legacy_tool", arguments: '{"a":1}' },
      tool_calls: [{ index: 0, id: "call_1", function: { name: "modern_tool", arguments: '{"b":2}' } }],
    });

    expect(finalize()).toBe("toolUse");
    expect(output.content).toEqual([{ type: "toolCall", id: "call_1", name: "modern_tool", arguments: { b: 2 } }]);
  });
});

/**
 * 台账差异第 38 行：arguments the stream cut in half are repaired
 * (`pretty.mjs:132940-132980`, applied at `pretty.mjs:133237-133239`) instead of
 * silently becoming `{}`, which would run the tool with no arguments at all.
 */
describe("truncated tool argument repair", () => {
  /** Feed one tool call whose accumulated `arguments` is `raw`, then finalize. */
  function finalArguments(raw: string): unknown {
    const { delta, finalize, output } = makeTranslator();
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: raw } }] });
    finalize();
    const [block] = output.content;
    return block.type === "toolCall" ? block.arguments : block;
  }

  it("completes a string value the stream cut in half", () => {
    expect(finalArguments('{"path":"/tmp/a.txt","content":"he')).toEqual({ path: "/tmp/a.txt", content: "he" });
  });

  it("closes an array the stream cut in half", () => {
    expect(finalArguments('{"items":[1,2')).toEqual({ items: [1, 2] });
  });

  it("is not misled by a brace inside a string value", () => {
    expect(finalArguments('{"s":"a}b')).toEqual({ s: "a}b" });
  });

  it("is not misled by an escaped quote inside a string value", () => {
    expect(finalArguments('{"s":"a\\"b')).toEqual({ s: 'a"b' });
  });

  it("drops an escape the stream cut mid-character", () => {
    // `"a\` can never be completed: closing the quote would only be escaped.
    expect(finalArguments('{"s":"a\\')).toEqual({ s: "a" });
  });

  it("gives a key cut before its value a null instead of losing the whole object", () => {
    expect(finalArguments('{"path":"/tmp/a","cont')).toEqual({ path: "/tmp/a", cont: null });
  });

  it("keeps the members that arrived when the last one is an unclosable literal", () => {
    expect(finalArguments('{"a":1,"b":tr')).toEqual({ a: 1 });
  });

  it("treats an empty argument string as a no-argument call", () => {
    expect(finalArguments("")).toEqual({});
  });

  it("throws rather than run the tool with silently empty arguments", () => {
    // The previous behaviour turned this into `{}` — a write with no path, a
    // delete with no target, executed without a word of warning.
    expect(() => finalArguments("{{{")).toThrow(/write_file sent arguments that are not parseable JSON/);
  });

  it("hands the repaired arguments to toolcall_end, which is what pi consumes", () => {
    const { delta, finalize, events, output } = makeTranslator();
    delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"/tmp/a' } }] });
    finalize();

    expect(events.find((e) => e.type === "toolcall_end")).toMatchObject({
      toolCall: { id: "call_1", name: "write_file", arguments: { path: "/tmp/a" } },
    });
    expect(output.content[0]).toMatchObject({ arguments: { path: "/tmp/a" } });
  });
});

/** An envelope as Qoder wraps it: the payload lives in `body` as a string. */
function envelopeData(body: unknown, statusCodeValue: unknown = 200): string {
  return JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body, statusCodeValue, statusCode: "OK" });
}

/** The error `push` threw, with the properties the retry layer reads off it. */
function pushError(frame: SSEFrame): Error & {
  status?: number;
  retryAfterMs?: number;
  duplicateRequest?: boolean;
  modelQueued?: boolean;
} {
  try {
    makeTranslator().push(frame);
  } catch (e) {
    return e as Error & { status?: number; retryAfterMs?: number; duplicateRequest?: boolean; modelQueued?: boolean };
  }
  throw new Error("expected push() to throw");
}

/**
 * 台账差异第 33 行：the sentinel vocabulary (`pretty.mjs:132782-132786`), whose
 * notification half (`pretty.mjs:133060-133068`, `pretty.mjs:133136-133146`) is
 * the only member that carries information for the user.
 */
describe("SSE sentinels", () => {
  it("ends the stream on a bare [DONE] and on an envelope wrapping it", () => {
    expect(makeTranslator().push({ data: "[DONE]" })).toBe("done");
    expect(makeTranslator().push({ data: envelopeData("[DONE]") })).toBe("done");
  });

  it("skips an empty event", () => {
    expect(makeTranslator().push({ data: "   " })).toBe("continue");
  });

  it("skips the quota sentinels", () => {
    // These are valid protocol messages, not payloads: feeding them to
    // JSON.parse reported normal traffic as corruption.
    const { push, output } = makeTranslator();
    expect(push({ data: "[NOT_EXCEED_QUOTA]" })).toBe("continue");
    expect(push({ data: '[EXCEED_QUOTA]{"used":100}' })).toBe("continue");
    expect(output.content).toEqual([]);
    expect(output.stopReason).toBe("stop");
  });

  it("reports a bare credit notification to the user", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = JSON.stringify({ notifications: [{ notificationType: "credit_exhausted", isHighestTier: true }] });

    expect(makeTranslator().push({ data: `[NOTIFICATIONS]#${payload}` })).toBe("continue");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("credit_exhausted");
    warn.mockRestore();
  });

  it("reports a credit notification that arrived inside an envelope body", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = JSON.stringify({ notifications: [{ notificationType: "quota_exceeded" }] });

    expect(makeTranslator().push({ data: envelopeData(`[NOTIFICATIONS]#${payload}`) })).toBe("continue");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("quota_exceeded");
    warn.mockRestore();
  });

  it("warns instead of throwing when the notification payload is not JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(makeTranslator().push({ data: "[NOTIFICATIONS]#{oops" })).toBe("continue");

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * 台账差异第 34 行：which events are envelopes, and what a failing one becomes
 * (`pretty.mjs:132788-132816`, `pretty.mjs:133157`).
 */
describe("response envelope classification", () => {
  it("throws with the upstream status attached", () => {
    const error = pushError({ data: envelopeData("gateway said no", 503) });

    expect(error.status).toBe(503);
    expect(error.message).toContain("gateway said no");
    expect(error.duplicateRequest).toBe(false);
    expect(error.modelQueued).toBe(false);
  });

  it("exempts the closing `event: finish` from the status check", () => {
    // The last event of a stream may report a non-200 status while the turn
    // itself succeeded; treating it as an error failed a completed answer.
    const { push, output } = makeTranslator();

    const result = push({
      data: envelopeData(JSON.stringify({ id: "resp_1", choices: [{ delta: { content: "hi" } }] }), 500),
      event: "finish",
    });

    expect(result).toBe("continue");
    expect(output.responseId).toBe("resp_1");
    expect(output.content[0]).toMatchObject({ type: "text", text: "hi" });
  });

  it("normalises a lost login to 401 whatever status the body arrived with", () => {
    expect(pushError({ data: envelopeData("Login Expired, please sign in again", 400) }).status).toBe(401);
    expect(pushError({ data: envelopeData("LOGIN TIMEOUT", 500) }).status).toBe(401);
  });

  it("carries the retry hints the body states", () => {
    const queued = pushError({ data: envelopeData(JSON.stringify({ code: "10605", retry_after_ms: 1500 }), 429) });
    expect(queued).toMatchObject({ status: 429, retryAfterMs: 1500, modelQueued: true });

    const duplicate = pushError({ data: envelopeData(JSON.stringify({ error: { code: 103 } }), 403) });
    expect(duplicate).toMatchObject({ status: 403, duplicateRequest: true });
    expect(duplicate.retryAfterMs).toBeUndefined();
  });

  it("reads the body of a 200 envelope", () => {
    const { push, output } = makeTranslator();

    expect(
      push({
        data: envelopeData(
          JSON.stringify({ id: "resp_2", model: "auto", usage: { prompt_tokens: 9, completion_tokens: 2 } }),
        ),
      }),
    ).toBe("continue");

    expect(output.responseId).toBe("resp_2");
    expect(output.responseModel).toBe("auto");
    expect(output.usage.input).toBe(9);
    expect(output.usage.output).toBe(2);
  });

  it("treats an event with no envelope as the payload itself", () => {
    // `statusCodeValue`/`body` are absent when the gateway answers without its
    // wrapper; demanding `body` dropped every chunk of such a stream.
    const { push, output } = makeTranslator();

    const result = push({
      data: JSON.stringify({
        id: "resp_3",
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        choices: [{ delta: { content: "bare" }, index: 0 }],
      }),
    });

    expect(result).toBe("continue");
    expect(output.responseId).toBe("resp_3");
    expect(output.usage.totalTokens).toBe(5);
    expect(output.content[0]).toMatchObject({ type: "text", text: "bare" });
  });

  it("does not mistake a payload carrying statusCodeValue for an envelope", () => {
    const { push, output } = makeTranslator();

    expect(push({ data: JSON.stringify({ id: "resp_4", statusCodeValue: 200 }) })).toBe("continue");

    expect(output.responseId).toBe("resp_4");
  });

  it("throws on a top-level error field", () => {
    expect(pushError({ data: JSON.stringify({ error: { message: "context length exceeded" } }) }).message).toContain(
      "context length exceeded",
    );
  });

  it("skips a malformed event without killing the stream", () => {
    const { push, output } = makeTranslator();

    expect(push({ data: "{not json" })).toBe("continue");
    expect(push({ data: envelopeData("{also not json}") })).toBe("continue");
    expect(push({ data: envelopeData(JSON.stringify({ id: "resp_5" })) })).toBe("continue");

    expect(output.responseId).toBe("resp_5");
  });
});
