import { describe, expect, it } from "vitest";
import { qoderEncodeBody, qoderEncodeBodyToBuffer } from "../qoder-encoding.js";

const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The straightforward per-character reference: base64, rotate by thirds,
 * substitute. Kept as the oracle for the table-driven implementation, which
 * exists only because this shape costs ~90s on a 350 KB body.
 */
function referenceEncode(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged[i];
    if (c === "=") {
      out += "$";
    } else {
      const idx = qoderStdAlphabet.indexOf(c);
      out += idx >= 0 ? qoderCustomAlphabet[idx] : c;
    }
  }
  return out;
}

describe("qoderEncodeBody", () => {
  it("encodes a simple string", () => {
    const result = qoderEncodeBody("hello");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Should not contain standard base64 padding char '='
    expect(result).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    const result = qoderEncodeBody(buf);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("produces deterministic output", () => {
    const a = qoderEncodeBody("test input");
    const b = qoderEncodeBody("test input");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", () => {
    const a = qoderEncodeBody("input A");
    const b = qoderEncodeBody("input B");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    const result = qoderEncodeBody("");
    expect(result).toBe("");
  });

  it("handles empty Buffer", () => {
    const result = qoderEncodeBody(Buffer.alloc(0));
    expect(result).toBe("");
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding — our encoding should use $
    const result = qoderEncodeBody("a");
    expect(result).not.toContain("=");
    expect(result).toContain("$");
  });

  it("uses custom alphabet (not standard base64)", () => {
    const result = qoderEncodeBody("The quick brown fox");
    // Standard base64 would use A-Za-z0-9+/=
    // Our encoding uses a custom alphabet, so the output should differ
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(result).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = qoderEncodeBody(binary);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const result = qoderEncodeBody(json);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("matches the reference encoder on edge cases and random binary", () => {
    const cases: Array<string | Buffer> = [
      "",
      "a",
      "ab",
      "abc",
      "hello",
      "The quick brown fox",
      "中文与 emoji 🎉 混排",
      JSON.stringify({ key: "value", num: 42 }),
      Buffer.alloc(0),
      Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]),
    ];
    for (let length = 0; length < 200; length++) {
      cases.push(Buffer.from(Array.from({ length }, (_, i) => (i * 37 + length * 11) % 256)));
    }
    for (const input of cases) {
      expect(qoderEncodeBody(input)).toBe(referenceEncode(input));
    }
  });

  it("returns the same bytes through the Buffer entry point", () => {
    const input = JSON.stringify({ messages: Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `m${i}` })) });
    expect(qoderEncodeBodyToBuffer(input).toString("latin1")).toBe(qoderEncodeBody(input));
  });

  it("encodes a long-conversation request body in milliseconds, not minutes", () => {
    // Regression guard for the hang: the per-character implementation needed
    // ~90s of CPU for a body this size (400 KB is a normal long session with
    // tool results), stalling pi's event loop long enough that the next request
    // reused a dead socket and failed with "fetch failed".
    const body = Buffer.from(JSON.stringify({ pad: "x".repeat(400_000) }));
    const start = process.hrtime.bigint();
    const encoded = qoderEncodeBodyToBuffer(body);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(encoded.length).toBe(Math.ceil(body.length / 3) * 4);
    expect(elapsedMs).toBeLessThan(500);
  });
});
