import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamQoder } from "../stream.js";

/**
 * Build a single SSE `data:` line carrying a Qoder envelope:
 *   { headers, body: <JSON string>, statusCodeValue, statusCode }
 * The server wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE =
  sseEnvelope(chunk({ role: "assistant" })) +
  sseEnvelope(chunk({ reasoning_content: "The user wants OK.", role: "assistant" })) +
  sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
  sseEnvelope(finishChunk("stop")) +
  DONE_SSE;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function makeModel(): Model<Api> {
  return { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context;
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses a successful SSE stream into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("surfaces an upstream 406 'Session blocked' as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    // Must NOT emit a silent done/stop.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage, responseId and responseModel from the finish chunk", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            // prompt_tokens (42) INCLUDES cached_tokens (5) per OpenAI
            // semantics; pi-core expects `input` to exclude them
            // (promptTokens = input + cacheRead + cacheWrite), so input =
            // 42 - 5 - 10 = 27. cacheable_tokens is a capacity metric, not a
            // write count, and must not be mapped to cacheWrite.
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    expect(msg.responseModel).toBe("qmodel_latest");
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
  });

  it("emits a done event with reason=length when finish_reason is length", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    expect((done as { reason: string }).reason).toBe("length");
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    const toolCall = msg.content.find((c) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
  });

  it("emits a tool call that arrives with no arguments", async () => {
    // A no-argument tool, or a model that sends id+name and stops. The block
    // used to be created only inside `if (tc.function?.arguments)`, so this
    // produced a toolCallsState entry and NO content block — and the finalizer
    // then set stopReason "toolUse" on a message with no tool call in it. pi's
    // agent loop had nothing to execute and the turn ended silently, mid-task.
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall, "a named tool call must reach the message even with no arguments").toBeDefined();
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    // Streamed the other way round: arguments first, identity later.
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    // A malformed stream: a tool_calls delta with neither id nor name. Better a
    // clean "stop" than a message that says toolUse and carries nothing, which
    // the agent loop cannot act on and cannot report.
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });

  it("retries a connection-level 'fetch failed' and streams the retry", async () => {
    // The failure that ended long conversations: after a tool call outlives
    // undici's keep-alive window, the pooled socket is dead and the very next
    // POST rejects in a few ms with TypeError: fetch failed. That is not a
    // model error — the request never reached the model — so it must be retried
    // rather than turned into stopReason "error".
    const socketError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socketError)
      .mockImplementation(
        async () => new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const done = events.find((e) => e.type === "done");
    expect(done, "expected the retry to produce a normal turn").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("retries a 503 but not a 401", async () => {
    const unavailable = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503, statusText: "Service Unavailable" }))
      .mockImplementation(
        async () => new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    globalThis.fetch = unavailable as unknown as typeof fetch;
    const retried = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(retried.find((e) => e.type === "done")).toBeDefined();

    const unauthorized = vi.fn(async () => new Response("token expired", { status: 401, statusText: "Unauthorized" }));
    globalThis.fetch = unauthorized as unknown as typeof fetch;
    const failed = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(unauthorized).toHaveBeenCalledTimes(1);
    const err = failed.find((e) => e.type === "error");
    expect((err as { error: AssistantMessage }).error.errorMessage).toMatch(/401/);
  });

  it("reports the cause chain instead of a bare 'fetch failed'", async () => {
    const opaque = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", name: "SystemError" }),
    });
    globalThis.fetch = vi.fn().mockRejectedValue(opaque) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    const message = (err as { error: AssistantMessage }).error.errorMessage ?? "";
    expect(message).toMatch(/fetch failed/);
    expect(message).toMatch(/ECONNRESET/);
  });

  it("keeps tool call arguments intact when a <thinking> tag leaks into content", async () => {
    // Qoder's backend leaks literal thinking tags into the content channel. The
    // parser used to splice the thinking block in front of the open text block,
    // renumbering the toolCall block while this function still held the old
    // index — so the finalizer wrote `arguments` onto the text block and the real
    // tool call was handed to the agent loop with `{}`. pi persists that message,
    // so the corruption also went back upstream on the next turn.
    const sse =
      sseEnvelope(chunk({ content: "Hello " })) +
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        }),
      ) +
      sseEnvelope(chunk({ content: "<thinking>hmm</thinking>" })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
    // No other block may have picked up tool-call fields.
    for (const block of msg.content) {
      if (block.type !== "toolCall") {
        expect(block, `${block.type} block must not carry tool call fields`).not.toHaveProperty("arguments");
      }
    }
    expect(msg.stopReason).toBe("toolUse");
  });

  it("translates finish_reason instead of passing the upstream vocabulary through", async () => {
    // pi's stopReason is a closed set. `content_filter` is not in it, and a cast
    // used to put it there, leaving pi with a reason it has no case for.
    globalThis.fetch = mockFetch(
      sseEnvelope(chunk({ content: "partial" })) + sseEnvelope(finishChunk("content_filter")) + DONE_SSE,
    );
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const done = events.find((e) => e.type === "done") as { reason: string; message: AssistantMessage } | undefined;
    expect(done?.message.stopReason).toBe("stop");
    expect(done?.reason).toBe("stop");
  });

  it("maps an unrecognised finish_reason to stop", async () => {
    globalThis.fetch = mockFetch(
      sseEnvelope(chunk({ content: "partial" })) + sseEnvelope(finishChunk("something_new")) + DONE_SSE,
    );
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const done = events.find((e) => e.type === "done") as { reason: string } | undefined;
    expect(done?.reason).toBe("stop");
  });

  it("errors when finish_reason=tool_calls arrives with no usable tool call", async () => {
    // A tool_calls delta with neither id nor name never becomes a block. Saying
    // "toolUse" anyway hands the agent loop a message with nothing to run, and
    // the turn ends mid-task without an error.
    const sse =
      sseEnvelope(chunk({ content: "working" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeUndefined();
    const err = events.find((e) => e.type === "error");
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/no usable tool call/);
    // The unattributable argument delta must not have been reported against
    // another block: contentIndex 0 is the text block.
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("working");
  });

  it("finishes on [DONE] without waiting for the server to close the socket", async () => {
    // The terminator used to `continue`, leaving the loop parked on
    // reader.read(). A gateway that holds the socket open then kept the turn
    // alive until the 300s idle watchdog fired.
    const body = SUCCESS_SSE;
    const neverClosing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        // Deliberately no controller.close().
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(neverClosing, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const done = events.find((e) => e.type === "done");
    expect(done, "expected the turn to finish on [DONE]").toBeDefined();
    expect((done as { message: AssistantMessage }).message.stopReason).toBe("stop");
  }, 5000);

  it("stops consuming payloads that follow the wrapped [DONE] in the same chunk", async () => {
    // splitSSEData is greedy: it hands back every complete `data:` line in the
    // buffer and knows nothing about [DONE], so the orchestration loop is what
    // has to stop at the terminator. The loop it replaced broke there. Both
    // trailing envelopes are observable if they are wrongly processed: the
    // content delta would land in the message, and the 500 would throw and turn
    // the turn into an error event.
    const sse =
      sseEnvelope(chunk({ content: "before", role: "assistant" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE +
      sseEnvelope(chunk({ content: "AFTER-DONE", role: "assistant" })) +
      sseEnvelope({ code: "provider_error", message: "after done" }, 500, "Internal Server Error");
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done, "expected the turn to finish on [DONE]").toBeDefined();
    const msg = done && "message" in done ? done.message : undefined;
    expect(msg?.stopReason).toBe("stop");
    const text = msg?.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("before");
    expect(events.some((e) => "delta" in e && String(e.delta).includes("AFTER-DONE"))).toBe(false);
  });

  it("stops consuming payloads that follow a bare data: [DONE] line", async () => {
    // Same contract for the unwrapped terminator, which is handled before the
    // envelope is even parsed.
    const sse =
      sseEnvelope(chunk({ content: "before", role: "assistant" })) +
      sseEnvelope(finishChunk("stop")) +
      "data: [DONE]\n\n" +
      sseEnvelope(chunk({ content: "AFTER-DONE", role: "assistant" })) +
      sseEnvelope({ code: "provider_error", message: "after done" }, 500, "Internal Server Error");
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done, "expected the turn to finish on [DONE]").toBeDefined();
    const msg = done && "message" in done ? done.message : undefined;
    expect(msg?.stopReason).toBe("stop");
    const text = msg?.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("before");
    expect(events.some((e) => "delta" in e && String(e.delta).includes("AFTER-DONE"))).toBe(false);
  });

  it("waits as long as Retry-After says on 429, not its own backoff", async () => {
    // Retry-After: 1s. The built-in backoff for the first retry is 500ms ±30%,
    // so a run that respects the header cannot finish the gap in under ~900ms
    // and a run that ignores it cannot take that long.
    const attemptTimes: number[] = [];
    const throttled = vi.fn(async () => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) {
        return new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "1" },
        });
      }
      return new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    globalThis.fetch = throttled as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(throttled).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(900);
  }, 5000);

  it("gives up instead of retrying when Retry-After exceeds the ceiling", async () => {
    // Ignoring Retry-After meant a 429 was retried three times 500ms apart,
    // tripling exactly the load that got the client throttled.
    const throttled = vi.fn(
      async () =>
        new Response("quota exhausted", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "3600" },
        }),
    );
    globalThis.fetch = throttled as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(throttled).toHaveBeenCalledTimes(1);
    const err = events.find((e) => e.type === "error");
    expect((err as { error: AssistantMessage }).error.errorMessage).toMatch(/429/);
  });
});
