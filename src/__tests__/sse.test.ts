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

  it("reassembles a payload that was cut across chunks", () => {
    const first = splitSSEData("data:hel");
    expect(first.payloads).toEqual([]);
    expect(first.rest).toBe("data:hel");
    const second = splitSSEData(`${first.rest}lo\n`);
    expect(second.payloads).toEqual(["hello"]);
    expect(second.rest).toBe("");
  });

  it("keeps leading whitespace of an incomplete tail verbatim in rest", () => {
    // rest is used to continue the next chunk, so its bytes must be preserved.
    const { payloads, rest } = splitSSEData("data:one\n   data:two");
    expect(payloads).toEqual(["one"]);
    expect(rest).toBe("   data:two");
  });
});

// ---------------------------------------------------------------------------
// Differential oracle. The body below is copied byte for byte out of the
// pre-optimisation implementation:
//
//   git show bac0cb4:src/sse.ts | sed -n '25,35p'
//
// Only the function name differs, so it can sit beside the import. The
// duplication is deliberate: the rewrite is a pure performance change and this
// is what proves it, so a failing case means the new scan is wrong - never
// "fix" it by editing this function.
// ---------------------------------------------------------------------------
function legacySplitSSEData(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  while (true) {
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) break;
    const line = rest.substring(0, lineEnd).trim();
    rest = rest.substring(lineEnd + 1);
    if (!line.startsWith("data:")) continue;
    payloads.push(line.substring(5).trim());
  }
  return { payloads, rest };
}

// --------------------------- end of oracle ---------------------------------

const manyPayloads = Array.from({ length: 64 }, (_, i) => `data:${i}\n`).join("");
const largeBuffer = `${Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? `event:e${i}\n` : `data:${i}\n`)).join(
  "",
)}data:tail-with-no-newline`;

describe("splitSSEData equals the pre-optimisation implementation", () => {
  const cases: Array<{ name: string; buffer: string }> = [
    { name: "an empty buffer", buffer: "" },
    { name: "a lone newline", buffer: "\n" },
    { name: "a lone CRLF", buffer: "\r\n" },
    { name: "consecutive blank lines", buffer: "\n\n\n\n" },
    { name: "a newline before anything else", buffer: "\ndata:tail\n" },
    { name: "one complete data line", buffer: "data:a\n" },
    { name: "an incomplete line with no newline at all", buffer: "data:partial" },
    { name: "a bare field name with no newline", buffer: "data:" },
    { name: "two data lines", buffer: "data:a\ndata:b\n" },
    { name: "blank-line separated events", buffer: "data:a\n\ndata:b\n\n" },
    { name: "many payloads in one chunk", buffer: manyPayloads },
    { name: "non-data fields and comments", buffer: "event:message\n:heartbeat\ndata:kept\n" },
    { name: "a field name with no colon", buffer: "data\ndata:ok\n" },
    { name: "an uppercase field name", buffer: "DATA:upper\ndata:lower\n" },
    { name: "text before the field name", buffer: "x data:not-a-field\n" },
    { name: "CRLF line endings", buffer: "data:a\r\ndata:b\r\n" },
    { name: "an empty payload", buffer: "data:\n" },
    { name: "an empty payload with CR", buffer: "data:\r\n" },
    { name: "a whitespace-only payload", buffer: "data:   \n" },
    { name: "no space after the colon", buffer: "data:tight\n" },
    { name: "redundant whitespace around and inside the payload", buffer: "data:   a  b   \n" },
    { name: "tabs around the payload", buffer: "data:\ta\t\n" },
    { name: "whitespace before the field name", buffer: "   data:indented\n" },
    { name: "a complete line followed by an incomplete tail", buffer: "data:   spaced   \ndata:tail" },
    { name: "an indented incomplete tail", buffer: "data:one\n   data:two" },
    { name: "a trailing bare field name", buffer: "data:x\ndata:" },
    { name: "a payload containing colons and JSON", buffer: 'data:{"a":"b:c"}\n' },
    { name: "a payload that repeats the field name", buffer: "data:data:inner\n" },
    { name: "a payload with an embedded CR", buffer: "data:a\rb\n" },
    { name: "a payload with an embedded NUL", buffer: "data:a\0b\n" },
    { name: "a multibyte payload", buffer: "data:\u4e2d\u6587 \ud83d\ude42\n" },
    // The split is greedy and knows no terminator, so everything after [DONE]
    // still comes back; stopping there is the caller's job.
    { name: "payloads after the wrapped terminator", buffer: 'data:{"body":"[DONE]"}\ndata:after\n' },
    { name: "payloads after a bare terminator", buffer: "data: [DONE]\n\ndata:after\n" },
    { name: "a large buffer", buffer: largeBuffer },
  ];

  for (const { name, buffer } of cases) {
    it(`matches for ${name}`, () => {
      expect(splitSSEData(buffer)).toEqual(legacySplitSSEData(buffer));
    });
  }
});

describe("splitSSEData threads rest across chunks like the pre-optimisation implementation", () => {
  const sequences: Array<{ name: string; chunks: string[] }> = [
    { name: "a payload cut mid-value", chunks: ["data:hel", "lo\n"] },
    { name: "a field name cut in half", chunks: ["dat", "a:split\n"] },
    { name: "a CR stranded at the chunk boundary", chunks: ["data:a\r", "\ndata:b\r\n"] },
    { name: "a newline arriving on its own", chunks: ["data:a", "\n"] },
    { name: "empty chunks between payloads", chunks: ["", "data:x\n", "", "\n"] },
    { name: "several payloads then a partial", chunks: ["data:a\ndata:b\ndata:", "c\ndata:d"] },
    { name: "an indented tail carried over", chunks: ["data:one\n   data:t", "wo\n"] },
    { name: "JSON split across three chunks", chunks: ['data:{"a"', ':1}\n\ndata:{"b"', ":2}\n\n"] },
    {
      name: "a line that grows over 50 chunks",
      chunks: ["data:", ...Array.from({ length: 50 }, () => "x".repeat(100)), "\n"],
    },
  ];

  for (const { name, chunks } of sequences) {
    it(`matches for ${name}`, () => {
      // Each implementation carries its own rest forward, so a wrong tail does
      // not get papered over by the next chunk - it diverges and stays diverged.
      let rest = "";
      let legacyRest = "";
      for (const [index, chunk] of chunks.entries()) {
        const actual = splitSSEData(rest + chunk);
        const expected = legacySplitSSEData(legacyRest + chunk);
        expect(actual, `chunk ${index}`).toEqual(expected);
        rest = actual.rest;
        legacyRest = expected.rest;
      }
    });
  }
});
