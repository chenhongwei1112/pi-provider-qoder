import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This file exists separately from request.test.ts on purpose. Both suites below
// need a model config that is known exactly, and the only door for one is
// getCachedModelConfig, which reads the on-disk cache. `vi.mock` is file-level
// and hoisted, so mocking models.js here keeps the differential suite in
// request.test.ts reading everything off the real return value and the decoded
// body, with no mock in sight.
vi.mock("../models.js", () => ({
  getCachedModelConfig: vi.fn(),
}));

import { getCachedModelConfig } from "../models.js";
import { buildChatRequest, chatRecordID } from "../request.js";
import { transformMessagesForQoder } from "../transform.js";

const mockedGetCachedModelConfig = vi.mocked(getCachedModelConfig);

// --- body decoder, copied from request.test.ts ------------------------------
// Duplicated rather than shared: a test helper that two suites can edit at once
// is a helper that can be bent to make a failing assertion pass.
const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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

function objectField(value: unknown, key: string): unknown {
  const found = field(value, key);
  if (typeof found !== "object" || found === null || Array.isArray(found)) {
    throw new Error(`${key} is not an object`);
  }
  return found;
}
// --- end of copied decoder -------------------------------------------------

const identity = { userID: "user-1", name: "Qoder User", email: "u@example.com", machineID: "machine-1" };
const model = { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
const context = {
  systemPrompt: "",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
} as unknown as Context;

/** Builds a request whose only variable is the cached `max_output_tokens`. */
function buildWith(maxOutputTokens: number, options?: SimpleStreamOptions) {
  mockedGetCachedModelConfig.mockReturnValue({
    key: "ultimate",
    is_reasoning: true,
    max_output_tokens: maxOutputTokens,
    source: "system",
  });
  const built = buildChatRequest({ model, context, options, providerMode: "qoder", identity });
  const body = decodeQoderBody(built.encodedBytes);
  return { body, maxTokens: numberField(field(body, "parameters"), "max_tokens") };
}

describe("buildChatRequest clamps a bad cached max_output_tokens", () => {
  beforeEach(() => {
    mockedGetCachedModelConfig.mockReset();
  });

  // A negative cap is truthy, so `max_output_tokens || 32768` lets it through.
  // The failure mode is silent: the request goes out with `max_tokens: -1`.
  for (const bad of [-1, -32768, Number.MIN_SAFE_INTEGER]) {
    it(`falls back to 32768 when the cache holds ${bad}`, () => {
      expect(buildWith(bad).maxTokens).toBe(32768);
    });
  }

  it("does not hash a negative cap into the record ids", () => {
    const { body } = buildWith(-1);
    expect(field(body, "request_set_id")).toBe(
      chatRecordID("ultimate", transformMessagesForQoder(context.messages), undefined, 32768),
    );
    expect(field(body, "request_set_id")).not.toBe(
      chatRecordID("ultimate", transformMessagesForQoder(context.messages), undefined, -1),
    );
  });

  it("falls back to 32768 when the cache holds 0", () => {
    // 0 is falsy, so this one is screened by `|| 32768` before the guard.
    expect(buildWith(0).maxTokens).toBe(32768);
  });

  it("keeps a normal positive cap", () => {
    expect(buildWith(8192).maxTokens).toBe(8192);
  });

  it("keeps a positive cap above the default", () => {
    expect(buildWith(65536).maxTokens).toBe(65536);
  });

  it("still lets a smaller caller cap win over a positive cache value", () => {
    expect(buildWith(65536, { maxTokens: 4096 } as SimpleStreamOptions).maxTokens).toBe(4096);
  });

  it("still lets a smaller caller cap win over a negative cache value", () => {
    // The clamp runs first, so the caller compares against 32768, not -1.
    expect(buildWith(-1, { maxTokens: 4096 } as SimpleStreamOptions).maxTokens).toBe(4096);
  });

  it("ignores a caller cap larger than the clamped default", () => {
    expect(buildWith(-1, { maxTokens: 100_000 } as SimpleStreamOptions).maxTokens).toBe(32768);
  });
});

describe("buildChatRequest pins the wire shape of the request body", () => {
  // The gateway contract is a fixed field set, and the COSY signature covers the
  // encoded body, so JSON.stringify's insertion order is part of the signed
  // bytes. Adding, dropping or reordering a key is a wire change. Only the four
  // ids are asserted elsewhere; these suites pin the key lists so the other
  // twenty fields cannot drift silently.
  //
  // Keys, not values: request_id and the random half of session_id change on
  // every call, so pinning values would force injection points for
  // crypto.randomUUID and Date.now. The shape is the contract; the values are not.
  beforeEach(() => {
    mockedGetCachedModelConfig.mockReset();
  });

  /** A model config with a known key list, so model_config can be pinned too. */
  function buildBody(ctx: Context = context): unknown {
    mockedGetCachedModelConfig.mockReturnValue({
      key: "ultimate",
      is_reasoning: true,
      max_output_tokens: 32768,
      source: "system",
    });
    return decodeQoderBody(
      buildChatRequest({
        model,
        context: ctx,
        options: { sessionId: "sess-9" } as SimpleStreamOptions,
        providerMode: "qoder",
        identity,
      }).encodedBytes,
    );
  }

  it("sends exactly these top-level keys, in this order", () => {
    expect(Object.keys(buildBody() as object)).toEqual([
      "request_id",
      "request_set_id",
      "chat_record_id",
      "session_id",
      "stream",
      "chat_task",
      "is_reply",
      "is_retry",
      "source",
      "version",
      "session_type",
      "agent_id",
      "task_id",
      "code_language",
      "chat_prompt",
      "image_urls",
      "aliyun_user_type",
      "system",
      "messages",
      "tools",
      "parameters",
      "chat_context",
      "model_config",
      "business",
    ]);
  });

  it("sends exactly these parameters keys", () => {
    expect(Object.keys(objectField(buildBody(), "parameters") as object)).toEqual(["max_tokens"]);
  });

  it("sends exactly these chat_context keys, in this order", () => {
    expect(Object.keys(objectField(buildBody(), "chat_context") as object)).toEqual([
      "chatPrompt",
      "imageUrls",
      "extra",
      "features",
      "text",
    ]);
  });

  it("sends exactly these chat_context.extra keys, in this order", () => {
    const extra = objectField(objectField(buildBody(), "chat_context"), "extra");
    expect(Object.keys(extra as object)).toEqual(["context", "modelConfig", "originalContent"]);
  });

  it("sends exactly these chat_context.extra.modelConfig keys, in this order", () => {
    const extra = objectField(objectField(buildBody(), "chat_context"), "extra");
    expect(Object.keys(objectField(extra, "modelConfig") as object)).toEqual(["key", "is_reasoning"]);
  });

  it("sends the cached model config through as model_config, key first", () => {
    // buildChatRequest overwrites modelConfig.key in place, which must not move
    // the key to the end of the object.
    expect(Object.keys(objectField(buildBody(), "model_config") as object)).toEqual([
      "key",
      "is_reasoning",
      "max_output_tokens",
      "source",
    ]);
  });

  it("sends exactly these business keys, in this order", () => {
    expect(Object.keys(objectField(buildBody(), "business") as object)).toEqual([
      "product",
      "version",
      "type",
      "stage",
      "id",
      "name",
      "begin_at",
    ]);
  });

  it("keeps the top-level shape when a system prompt is present", () => {
    // The system prompt changes body.messages but must not add or move a key.
    const withSystem = { ...(context as object), systemPrompt: "a system prompt" } as unknown as Context;
    expect(Object.keys(buildBody(withSystem) as object)).toEqual(Object.keys(buildBody() as object));
  });
});
