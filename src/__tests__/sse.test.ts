import { describe, expect, it } from "vitest";
import { MAX_SSE_LINE_BYTES, SSEFramer, SSEProtocolLimitError } from "../sse.js";

describe("SSEFramer", () => {
  it("delivers a frame for a single data line followed by a blank line", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:hello\n\n")).toEqual([{ data: "hello" }]);
  });

  it("joins several data lines of one block with newlines", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:one\ndata:two\ndata:three\n\n")).toEqual([{ data: "one\ntwo\nthree" }]);
  });

  it("delivers nothing until the blank line arrives", () => {
    const framer = new SSEFramer();
    // The block is syntactically complete apart from its terminator, so a
    // framer that delivered per line instead of per block would hand the
    // translator half an event.
    expect(framer.push("data:one\ndata:two\n")).toEqual([]);
    expect(framer.push("\n")).toEqual([{ data: "one\ntwo" }]);
  });

  it("delivers every complete block in one chunk, in order", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:a\n\ndata:b\n\ndata:c\n\n")).toEqual([{ data: "a" }, { data: "b" }, { data: "c" }]);
  });

  it("reassembles a block whose data value was cut across chunks", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:hel")).toEqual([]);
    expect(framer.push("lo\n\n")).toEqual([{ data: "hello" }]);
  });

  it("reassembles a block whose field name was cut across chunks", () => {
    const framer = new SSEFramer();
    expect(framer.push("dat")).toEqual([]);
    expect(framer.push("a:split\n\n")).toEqual([{ data: "split" }]);
  });

  it("keeps event and id on the frame", () => {
    const framer = new SSEFramer();
    // `event` is load bearing downstream: a non-200 envelope on `event:finish`
    // is not an error, so dropping the field would turn clean finishes into
    // failures.
    expect(framer.push("event:finish\nid:42\ndata:{}\n\n")).toEqual([{ data: "{}", event: "finish", id: "42" }]);
  });

  it("ignores retry and unknown fields without ending the block", () => {
    const framer = new SSEFramer();
    expect(framer.push("retry:3000\nfoo:bar\ndata:kept\n\n")).toEqual([{ data: "kept" }]);
  });

  it("ignores comment lines that start with a colon", () => {
    const framer = new SSEFramer();
    expect(framer.push(":heartbeat comment\ndata:kept\n\n")).toEqual([{ data: "kept" }]);
  });

  it("ignores lines that contain no colon", () => {
    const framer = new SSEFramer();
    // A colonless line is skipped outright rather than read as a field with an
    // empty value, so it must not become `data` and must not end the block.
    expect(framer.push("garbage\ndata:kept\n\n")).toEqual([{ data: "kept" }]);
  });

  it("strips only one leading space from a field value", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:  x\n\n")).toEqual([{ data: " x" }]);
  });

  it("does not trim the field value", () => {
    const framer = new SSEFramer();
    // JSON.parse tolerates the trailing space; a trim here would be silent
    // rewriting of the payload, which the byte accounting also has to match.
    expect(framer.push('data: {"a":1} \n\n')).toEqual([{ data: '{"a":1} ' }]);
  });

  it("frames a CRLF stream by stripping the trailing carriage return", () => {
    const framer = new SSEFramer();
    expect(framer.push("event:message\r\ndata:crlf\r\n\r\n")).toEqual([{ data: "crlf", event: "message" }]);
  });

  it("strips only one trailing carriage return", () => {
    const framer = new SSEFramer();
    expect(framer.push("data:cr\r\r\n\n")).toEqual([{ data: "cr\r" }]);
  });

  it("produces no frame for heartbeat blank lines", () => {
    const framer = new SSEFramer();
    expect(framer.push("\n\n\n")).toEqual([]);
  });

  it("delivers a frame for a bare data field", () => {
    const framer = new SSEFramer();
    // A `data:` line with no value still makes the block deliverable, unlike a
    // block that never saw a field at all.
    expect(framer.push("data:\n\n")).toEqual([{ data: "" }]);
  });

  it("delivers a frame for a block that carries only an id", () => {
    const framer = new SSEFramer();
    expect(framer.push("id:7\n\n")).toEqual([{ data: "", id: "7" }]);
  });

  it("clears event and id after delivering a frame", () => {
    const framer = new SSEFramer();
    expect(framer.push("event:message\nid:1\ndata:first\n\n")).toEqual([{ data: "first", event: "message", id: "1" }]);
    expect(framer.push("data:second\n\n")).toEqual([{ data: "second" }]);
  });

  it("throws when a single line exceeds the line byte ceiling", () => {
    const framer = new SSEFramer();
    const half = "d".repeat(MAX_SSE_LINE_BYTES / 2 + 1);
    // Split in two so the ceiling is proven to be charged against the line as
    // it accumulates, not against one chunk at a time.
    expect(framer.push(half)).toEqual([]);
    expect(() => framer.push(half)).toThrow(SSEProtocolLimitError);
  });

  it("reports the ceiling and the actual size on a line overflow", () => {
    const framer = new SSEFramer();
    const overshoot = MAX_SSE_LINE_BYTES + 1;
    try {
      framer.push("d".repeat(overshoot));
      expect.unreachable("expected a protocol limit error");
    } catch (e) {
      expect(e).toBeInstanceOf(SSEProtocolLimitError);
      const error = e as SSEProtocolLimitError;
      expect(error.limitKind).toBe("line");
      expect(error.limitBytes).toBe(MAX_SSE_LINE_BYTES);
      expect(error.actualBytes).toBe(overshoot);
      expect(error.message).toContain(String(MAX_SSE_LINE_BYTES));
      expect(error.message).toContain(String(overshoot));
    }
  });

  it("measures the line ceiling in UTF-8 bytes, not code units", () => {
    const framer = new SSEFramer();
    // Half as many code units as the ceiling, but two bytes each: counting
    // characters instead of bytes would let this line through.
    const line = "é".repeat(MAX_SSE_LINE_BYTES / 2 + 1);
    expect(line.length).toBeLessThan(MAX_SSE_LINE_BYTES);
    expect(() => framer.push(line)).toThrow(SSEProtocolLimitError);
  });
});
