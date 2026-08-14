import crypto from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildChatRequest, chatRecordID, stableID } from "../request.js";
import { transformMessagesForQoder } from "../transform.js";

// ---------------------------------------------------------------------------
// Differential oracle. The two pre-merge helpers below are copied byte for byte
// out of the commit this rewrite starts from:
//
//   git show bac0cb4:src/request.ts | sed -n '8,45p'
//
// They are deliberately duplicated logic: the chat record id and the session id
// both travel in the request body, so a silent divergence would be a wire
// change. Nothing between here and the closing banner may be adjusted to make a
// test pass - if a case fails, the merged implementation is wrong.
// ---------------------------------------------------------------------------

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

// --------------------------- end of oracle ---------------------------------

describe("stableID", () => {
  const cases: Array<{ name: string; prefix: string; parts: string[] }> = [
    // The live session-id call site: buildChatRequest hashes user id + model.
    { name: "the session id call site", prefix: "qoder-session", parts: ["user-1", "dmodel"] },
    { name: "no parts at all", prefix: "qoder-session", parts: [] },
    { name: "one empty part", prefix: "p", parts: [""] },
    // Several empty parts still feed one separator each, so the digest must not
    // collapse them.
    { name: "several empty parts", prefix: "p", parts: ["", "", ""] },
    // A part that contains the separator itself is where a naive join("\0")
    // rewrite would differ from update-per-part hashing.
    { name: "a part containing the NUL separator", prefix: "p", parts: ["a\0b", "c"] },
    { name: "a prefix containing NUL", prefix: "p\0", parts: ["x"] },
    { name: "multibyte prefix and parts", prefix: "\u524d\u7f00", parts: ["\u4e2d\u6587", "\ud83d\ude42"] },
    // Lone surrogates are re-encoded by Buffer; both sides must do it the same way.
    { name: "a lone surrogate", prefix: "p", parts: ["\ud800"] },
    { name: "a part larger than one hash block", prefix: "p", parts: ["x".repeat(100_000), "tail"] },
  ];

  for (const { name, prefix, parts } of cases) {
    it(`matches the pre-merge stableHash: ${name}`, () => {
      expect(stableID(prefix, parts)).toBe(stableHash(prefix, ...parts));
    });
  }

  it("accepts any iterable, not only an array", () => {
    // buildChatRequest passes an array today, but the parameter is Iterable and
    // a lazy source must hash identically.
    function* parts(): Generator<string> {
      yield "user-1";
      yield "dmodel";
    }
    expect(stableID("qoder-session", parts())).toBe(stableHash("qoder-session", "user-1", "dmodel"));
  });

  it("distinguishes different part boundaries", () => {
    // The separator exists to stop ["ab","c"] and ["a","bc"] from colliding.
    expect(stableID("p", ["ab", "c"])).not.toBe(stableID("p", ["a", "bc"]));
  });

  it("separates the domain prefix from the parts", () => {
    expect(stableID("qoder-session", ["x"])).not.toBe(stableID("qoder-record", ["x"]));
  });

  it("returns 16 lowercase hex characters", () => {
    expect(stableID("p", ["x"])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("chatRecordID", () => {
  type Msg = { role?: string; content?: unknown };
  const cases: Array<{ name: string; messages: Msg[]; tools: unknown; maxTokens: number }> = [
    { name: "empty history", messages: [], tools: undefined, maxTokens: 32768 },
    { name: "string content", messages: [{ role: "user", content: "hi" }], tools: undefined, maxTokens: 32768 },
    // Non-string content goes through JSON.stringify in both implementations.
    {
      name: "array content",
      messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
      tools: undefined,
      maxTokens: 32768,
    },
    { name: "object content", messages: [{ role: "user", content: { a: 1 } }], tools: undefined, maxTokens: 32768 },
    { name: "numeric content", messages: [{ role: "user", content: 42 }], tools: undefined, maxTokens: 32768 },
    // Every falsy content is skipped entirely - no separator, no value.
    {
      name: "empty-string content is skipped",
      messages: [{ role: "user", content: "" }],
      tools: undefined,
      maxTokens: 32768,
    },
    { name: "zero content is skipped", messages: [{ role: "user", content: 0 }], tools: undefined, maxTokens: 32768 },
    {
      name: "false content is skipped",
      messages: [{ role: "user", content: false }],
      tools: undefined,
      maxTokens: 32768,
    },
    {
      name: "null content is skipped",
      messages: [{ role: "user", content: null }],
      tools: undefined,
      maxTokens: 32768,
    },
    {
      name: "NaN content is skipped",
      messages: [{ role: "user", content: Number.NaN }],
      tools: undefined,
      maxTokens: 32768,
    },
    { name: "missing role", messages: [{ content: "orphan" }], tools: undefined, maxTokens: 32768 },
    { name: "missing content", messages: [{ role: "user" }], tools: undefined, maxTokens: 32768 },
    { name: "empty role is skipped", messages: [{ role: "", content: "x" }], tools: undefined, maxTokens: 32768 },
    { name: "neither role nor content", messages: [{}], tools: undefined, maxTokens: 32768 },
    {
      name: "a longer mixed history",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_call", id: "t1" }] },
        { role: "tool", content: "" },
        { content: "no role" },
        { role: "user", content: "\u4e2d\u6587 \ud83d\ude42" },
      ],
      tools: [{ name: "bash" }],
      maxTokens: 4096,
    },
    // Content carrying the separator: the field boundary must stay unambiguous.
    {
      name: "content containing NUL",
      messages: [{ role: "user", content: "a\0b" }],
      tools: undefined,
      maxTokens: 32768,
    },
    // tools is checked for truthiness, not length: [] hashes as "[]".
    { name: "empty tools array is truthy", messages: [], tools: [], maxTokens: 32768 },
    { name: "empty tools object is truthy", messages: [], tools: {}, maxTokens: 32768 },
    {
      name: "populated tools",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash" }],
      maxTokens: 32768,
    },
    { name: "null tools", messages: [], tools: null, maxTokens: 32768 },
    { name: "zero tools is falsy", messages: [], tools: 0, maxTokens: 32768 },
    { name: "empty-string tools is falsy", messages: [], tools: "", maxTokens: 32768 },
    // The mt= suffix is interpolated, so every numeric edge must stringify alike.
    { name: "zero max tokens", messages: [], tools: undefined, maxTokens: 0 },
    { name: "one max token", messages: [], tools: undefined, maxTokens: 1 },
    { name: "negative max tokens", messages: [], tools: undefined, maxTokens: -1 },
    { name: "max safe integer max tokens", messages: [], tools: undefined, maxTokens: Number.MAX_SAFE_INTEGER },
    { name: "fractional max tokens", messages: [], tools: undefined, maxTokens: 0.5 },
    { name: "infinite max tokens", messages: [], tools: undefined, maxTokens: Number.POSITIVE_INFINITY },
  ];

  for (const { name, messages, tools, maxTokens } of cases) {
    it(`matches the pre-merge stableChatRecordID: ${name}`, () => {
      expect(chatRecordID("dmodel", messages, tools, maxTokens)).toBe(
        stableChatRecordID("dmodel", messages, tools, maxTokens),
      );
    });
  }

  it("keeps the token cap inside the id", () => {
    expect(chatRecordID("dmodel", [], undefined, 32768)).not.toBe(chatRecordID("dmodel", [], undefined, 4096));
  });

  it("keeps an empty tools array distinct from no tools", () => {
    // Guards the `if (tools)` truthiness check the old implementation used.
    expect(chatRecordID("dmodel", [], [], 32768)).not.toBe(chatRecordID("dmodel", [], undefined, 32768));
  });

  it("keeps the model inside the id", () => {
    expect(chatRecordID("dmodel", [], undefined, 32768)).not.toBe(chatRecordID("qmodel", [], undefined, 32768));
  });

  it("returns 16 lowercase hex characters", () => {
    expect(chatRecordID("dmodel", [{ role: "user", content: "hi" }], undefined, 32768)).toMatch(/^[0-9a-f]{16}$/);
  });
});

const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Inverse of `qoderEncodeBodyToBuffer`, so the ids can be read off the wire.
 *
 * The encoder substitutes the alphabet and rotates the base64 by thirds; that
 * rotation is its own inverse, so decoding is the same rotation with the
 * substitution reversed.
 */
function decodeQoderBody(encoded: Buffer): unknown {
  const inverse = Buffer.allocUnsafe(256);
  for (let byte = 0; byte < 256; byte++) inverse[byte] = byte;
  for (let i = 0; i < qoderStdAlphabet.length; i++) {
    inverse[qoderCustomAlphabet.charCodeAt(i)] = qoderStdAlphabet.charCodeAt(i);
  }
  inverse[0x24 /* $ */] = 0x3d /* = */;
  const n = encoded.length;
  const plain = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) plain[i] = inverse[encoded[i]];
  const a = Math.floor(n / 3);
  const base64 = Buffer.concat([plain.subarray(n - a), plain.subarray(a, n - a), plain.subarray(0, a)]);
  return JSON.parse(Buffer.from(base64.toString("latin1"), "base64").toString("utf8"));
}

/** Reads one field off the decoded body, failing loudly instead of assuming a shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`decoded request body has no ${key}`);
  }
  return Reflect.get(value, key);
}

function numberField(value: unknown, key: string): number {
  const found = field(value, key);
  if (typeof found !== "number") throw new Error(`${key} is not a number`);
  return found;
}

function arrayField(value: unknown, key: string): unknown[] {
  const found = field(value, key);
  if (!Array.isArray(found)) throw new Error(`${key} is not an array`);
  return found;
}

describe("buildChatRequest wires the ids into the body", () => {
  // Neither differential suite above can see an argument swapped at the call
  // site, and both ids ship inside the request body, so read them back off the
  // encoded bytes. Everything the ids depend on is taken from the returned
  // request or the decoded body, never from the on-disk model cache.
  const identity = { userID: "user-1", name: "Qoder User", email: "u@example.com", machineID: "machine-1" };
  const model = { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
  const context = {
    systemPrompt: "a system prompt",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    tools: [],
  } as unknown as Context;
  const built = buildChatRequest({
    model,
    context,
    options: { sessionId: "sess-9", maxTokens: 100 } as SimpleStreamOptions,
    providerMode: "qoder",
    identity,
  });
  const body = decodeQoderBody(built.encodedBytes);
  const maxTokens = numberField(field(body, "parameters"), "max_tokens");

  it("prefixes session_id with the user id and the model, in that order", () => {
    expect(field(body, "session_id")).toBe(`${stableID("qoder-session", [identity.userID, built.qoderModel])}-sess-9`);
  });

  it("hashes the chat record over the model, the messages, the tools and the cap", () => {
    // The system prompt is prepended to body.messages but is not part of the
    // id, so hashing the wrong message list would show up here.
    expect(field(body, "chat_record_id")).toBe(
      chatRecordID(built.qoderModel, transformMessagesForQoder(context.messages), undefined, maxTokens),
    );
  });

  it("reuses one record id for request_set_id and chat_record_id", () => {
    expect(field(body, "request_set_id")).toBe(field(body, "chat_record_id"));
  });

  it("sends the system prompt as a leading message without hashing it", () => {
    // Pins the premise of the test above: the hashed list and the sent list differ.
    const messages = arrayField(body, "messages");
    expect(field(messages[0], "role")).toBe("system");
    expect(messages.length).toBe(context.messages.length + 1);
  });
});
