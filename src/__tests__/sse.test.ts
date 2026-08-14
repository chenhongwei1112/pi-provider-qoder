import { describe, expect, it } from "vitest";
import { splitSSEData } from "../sse.js";

describe("splitSSEData", () => {
  it("returns the payload of a single complete data line", () => {
    const { payloads, rest } = splitSSEData("data:hello\n");
    expect(payloads).toEqual(["hello"]);
    expect(rest).toBe("");
  });

  it("keeps an incomplete trailing line in rest", () => {
    const { payloads, rest } = splitSSEData("data:first\ndata:seco");
    expect(payloads).toEqual(["first"]);
    expect(rest).toBe("data:seco");
  });

  it("returns every data line in one chunk, in order", () => {
    const { payloads } = splitSSEData("data:a\n\ndata:b\n\ndata:c\n");
    expect(payloads).toEqual(["a", "b", "c"]);
  });

  it("drops lines that are not data fields", () => {
    // `event:` and comment lines (`:`) are valid SSE the provider does not use.
    const { payloads } = splitSSEData("event:message\n:heartbeat\ndata:kept\n");
    expect(payloads).toEqual(["kept"]);
  });

  it("tolerates CRLF line endings", () => {
    // trim() removes the \r, so the payload must come through clean.
    const { payloads, rest } = splitSSEData("data:crlf\r\n");
    expect(payloads).toEqual(["crlf"]);
    expect(rest).toBe("");
  });

  it("yields an empty payload for a bare data field", () => {
    const { payloads } = splitSSEData("data:\n");
    expect(payloads).toEqual([""]);
  });

  it("ignores blank lines", () => {
    const { payloads, rest } = splitSSEData("\n\n\n");
    expect(payloads).toEqual([]);
    expect(rest).toBe("");
  });

  it("returns the whole buffer as rest when there is no line break yet", () => {
    const { payloads, rest } = splitSSEData("data:partial");
    expect(payloads).toEqual([]);
    expect(rest).toBe("data:partial");
  });

  it("strips whitespace around the payload", () => {
    const { payloads } = splitSSEData("data:   spaced   \n");
    expect(payloads).toEqual(["spaced"]);
  });
});
