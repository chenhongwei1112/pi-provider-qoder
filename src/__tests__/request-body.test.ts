import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModelConfig, thinkingFor } from "../models.js";

// This file exists separately from request.test.ts on purpose. Both suites below
// need a model config that is known exactly, and the only door for one is
// getCachedModelConfig, which reads the on-disk cache. `vi.mock` is file-level
// and hoisted, so mocking models.js here keeps the differential suite in
// request.test.ts reading everything off the real return value and the decoded
// body, with no mock in sight.
vi.mock("../models.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getCachedModelConfig: vi.fn(),
}));

import {
  buildChatParameters,
  buildChatRequest,
  buildModelConfig,
  chatRecordID,
  clampMaxTokens,
  effectiveIsReasoning,
} from "../request.js";
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

function arrayField(value: unknown, key: string): unknown[] {
  const found = field(value, key);
  if (!Array.isArray(found)) throw new Error(`${key} is not an array`);
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

  // A negative cap is truthy, so it survives a plain `||` guard. The failure mode
  // is silent: the request would go out with `max_tokens: -1`.
  for (const bad of [-1, -32768, Number.MIN_SAFE_INTEGER]) {
    it(`falls back to 32000 when the cache holds ${bad}`, () => {
      expect(buildWith(bad).maxTokens).toBe(32000);
    });
  }

  it("does not hash a negative cap into the record ids", () => {
    const { body } = buildWith(-1);
    expect(field(body, "request_set_id")).toBe(
      chatRecordID("ultimate", transformMessagesForQoder(context.messages), undefined, 32000),
    );
    expect(field(body, "request_set_id")).not.toBe(
      chatRecordID("ultimate", transformMessagesForQoder(context.messages), undefined, -1),
    );
  });

  it("falls back to 32000 when the cache holds 0", () => {
    // `pretty.mjs:105460` keeps a cap only when it is strictly greater than zero.
    expect(buildWith(0).maxTokens).toBe(32000);
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
    // The clamp runs first, so the caller compares against 32000, not -1.
    expect(buildWith(-1, { maxTokens: 4096 } as SimpleStreamOptions).maxTokens).toBe(4096);
  });

  it("ignores a caller cap larger than the clamped default", () => {
    expect(buildWith(-1, { maxTokens: 100_000 } as SimpleStreamOptions).maxTokens).toBe(32000);
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

  /**
   * Decodes the body of one buildChatRequest call. The getCachedModelConfig mock
   * must already be installed: the cache-miss tests below install their own.
   */
  function decodeBuiltBody(ctx: Context = context): unknown {
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

  /** A model config with a known key list, so model_config can be pinned too. */
  function buildBody(ctx: Context = context): unknown {
    mockedGetCachedModelConfig.mockReturnValue({
      key: "ultimate",
      is_reasoning: true,
      max_output_tokens: 32768,
      source: "system",
    });
    return decodeBuiltBody(ctx);
  }

  it("sends exactly these top-level keys, in this order", () => {
    expect(Object.keys(buildBody() as object)).toEqual([
      "request_id",
      "request_set_id",
      "chat_record_id",
      "session_id",
      "stream",
      "chat_task",
      "chat_context",
      "is_reply",
      "is_retry",
      "source",
      "version",
      "agent_id",
      "task_id",
      "session_type",
      "aliyun_user_type",
      "model_config",
      "system",
      "messages",
      "tools",
      "parameters",
      "business",
    ]);
  });

  it("does not send the three top-level keys the official client has no concept of", () => {
    // `code_language`, `chat_prompt` and `image_urls` were plugin inventions; the
    // first two literals have zero hits in the official bundle, and the official
    // concepts live in `chat_context.chatPrompt` / `chat_context.imageUrls`
    // (ledger row 17). Key-order lists are easy to extend by accident, so name
    // them explicitly.
    const keys = Object.keys(buildBody() as object);
    expect(keys).not.toContain("code_language");
    expect(keys).not.toContain("chat_prompt");
    expect(keys).not.toContain("image_urls");
  });

  it("sends the real system prompt at the top level as well as in messages", () => {
    // Official populates both (`pretty.mjs:132108` + `pretty.mjs:132123`). Sending
    // an empty `system` beside a `messages[0].role === "system"` is a fingerprint
    // (ledger row 18).
    const withSystem = { ...(context as object), systemPrompt: "a system prompt" } as unknown as Context;
    const body = buildBody(withSystem);
    expect(field(body, "system")).toBe("a system prompt");
    const messages = arrayField(body, "messages") as Array<{ role?: string; content?: unknown }>;
    expect(messages[0]).toMatchObject({ content: "a system prompt", role: "system" });
  });

  it("keeps system as an empty string when there is no prompt", () => {
    // `system: A11 ?? ""` (`pretty.mjs:132123`) — the key is always present.
    expect(field(buildBody(), "system")).toBe("");
  });

  it("sends exactly these parameters keys", () => {
    expect(Object.keys(objectField(buildBody(), "parameters") as object)).toEqual(["max_tokens"]);
  });

  it("sends exactly these chat_context keys, in this order", () => {
    expect(Object.keys(objectField(buildBody(), "chat_context") as object)).toEqual([
      "text",
      "features",
      "extra",
      "chatPrompt",
      "imageUrls",
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

  it("sends exactly these model_config keys, in this order", () => {
    // `pretty.mjs:132131`: a fixed ten-key object, built field by field instead of
    // by handing the cached catalog entry over.
    expect(Object.keys(objectField(buildBody(), "model_config") as object)).toEqual([
      "key",
      "display_name",
      "model",
      "format",
      "is_vl",
      "is_reasoning",
      "api_key",
      "url",
      "source",
      "max_input_tokens",
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

  // --- the non-empty tools branch -------------------------------------------
  // Every fixture above sends `tools: []`, so the element shape transformTools
  // produces has never reached the wire in a test. transform.test.ts pins those
  // elements with toEqual, and toEqual does not compare key order, so nothing
  // guarded the order of these signed bytes.
  const contextWithTools = {
    systemPrompt: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  } as unknown as Context;

  it("sends exactly these tools element keys, in this order", () => {
    const tools = arrayField(buildBody(contextWithTools), "tools");
    expect(tools).toHaveLength(1);
    expect(Object.keys(objectField(tools, "0") as object)).toEqual(["type", "function"]);
  });

  it("sends exactly these tools element function keys, in this order", () => {
    const tool = objectField(arrayField(buildBody(contextWithTools), "tools"), "0");
    expect(Object.keys(objectField(tool, "function") as object)).toEqual(["name", "description", "parameters"]);
  });

  it("keeps the top-level shape when tools are present", () => {
    // `tools` is written unconditionally as `toolsRaw || []`, so a non-empty tools
    // array must not add a key either. The length assertion keeps this test from
    // quietly falling back to the empty branch it exists to leave.
    const body = buildBody(contextWithTools);
    expect(arrayField(body, "tools")).toHaveLength(1);
    expect(Object.keys(body as object)).toEqual(Object.keys(buildBody() as object));
  });

  // --- the cache-miss branch ------------------------------------------------
  it("sends the same model_config shape on a cache miss", () => {
    // getCachedModelConfig returns null for a model with no cache entry, which is
    // the first-request path. buildChatRequest's own fallback entry carries a
    // `max_output_tokens` the official shape has no slot for, so this pins that the
    // miss path is built too, not passed through.
    mockedGetCachedModelConfig.mockReturnValue(null);
    expect(Object.keys(objectField(decodeBuiltBody(), "model_config") as object)).toEqual([
      "key",
      "display_name",
      "model",
      "format",
      "is_vl",
      "is_reasoning",
      "api_key",
      "url",
      "source",
      "max_input_tokens",
    ]);
  });
});

// --- the reasoning effort carrier (ledger rows 19 and 21) -------------------
// The effort used to be shaped into `model_config.thinking_config.…is_default`
// and mirrored into `chat_context.extra.modelConfig.thinking_effort`. Neither
// carrier exists in the official body: `pretty.mjs:132131` builds model_config
// from ten fixed keys and `thinking_config` is not one of them, and the
// `thinking_effort` literal has zero hits in the official bundle. So both an
// explicit effort and `--thinking off` were dropped on the floor.
// `parameters` is the carrier (`pretty.mjs:132112-132118`).
describe("buildChatParameters", () => {
  it("writes only max_tokens when no thinking preference was given", () => {
    // The official default path starts from an empty object and writes just the
    // cap (`pretty.mjs:132110-132111`).
    expect(buildChatParameters({ maxTokens: 32000, thinkingDisabled: false })).toEqual({ max_tokens: 32000 });
  });

  it("sends exactly these parameters keys, in this order, for an explicit effort", () => {
    const parameters = buildChatParameters({ maxTokens: 32000, reasoningEffort: "high", thinkingDisabled: false });
    expect(Object.keys(parameters)).toEqual(["max_tokens", "reasoning_effort", "enable_thinking"]);
    expect(parameters).toEqual({ max_tokens: 32000, reasoning_effort: "high", enable_thinking: true });
  });

  it("turns thinking off with effort none and enable_thinking false", () => {
    const parameters = buildChatParameters({ maxTokens: 32000, thinkingDisabled: true });
    expect(parameters.reasoning_effort).toBe("none");
    expect(parameters.enable_thinking).toBe(false);
  });

  it("does not write reasoning_budget_tokens when thinking is off", () => {
    // `pretty.mjs:132115` deletes the key on `none`, and omp exposes no thinking
    // budget that could have written it in the first place (`pretty.mjs:132116`).
    expect(Object.keys(buildChatParameters({ maxTokens: 32000, thinkingDisabled: true }))).not.toContain(
      "reasoning_budget_tokens",
    );
  });

  it("treats an effort of none as a disable request", () => {
    expect(buildChatParameters({ maxTokens: 32000, reasoningEffort: "none", thinkingDisabled: false })).toEqual({
      max_tokens: 32000,
      reasoning_effort: "none",
      enable_thinking: false,
    });
  });

  it("lets a disable request win over an effort", () => {
    expect(buildChatParameters({ maxTokens: 32000, reasoningEffort: "high", thinkingDisabled: true })).toEqual({
      max_tokens: 32000,
      reasoning_effort: "none",
      enable_thinking: false,
    });
  });
});

describe("effectiveIsReasoning", () => {
  it("reports false for a reasoning model when the caller switched thinking off", () => {
    // `pretty.mjs:132119`: the catalog says the model reasons, this turn does not.
    expect(effectiveIsReasoning(true, true)).toBe(false);
  });

  it("reports false when the effort is none", () => {
    expect(effectiveIsReasoning(true, false, "none")).toBe(false);
  });

  it("follows the catalog for a normal effort", () => {
    expect(effectiveIsReasoning(true, false, "high")).toBe(true);
    expect(effectiveIsReasoning(false, false, "high")).toBe(false);
  });

  it("follows the catalog when nothing was requested", () => {
    expect(effectiveIsReasoning(true, false)).toBe(true);
    expect(effectiveIsReasoning(false, false)).toBe(false);
  });
});

describe("buildChatRequest carries the thinking preference in parameters", () => {
  beforeEach(() => {
    mockedGetCachedModelConfig.mockReset();
  });

  // The `thinking_config` block the old hack used to patch: `disabled` drove the
  // `--thinking off` branch and `enabled.efforts` the effort branch. Held in a
  // variable rather than written inline so the `disabled` slot, which the entry
  // type admits only through its index signature, stays assignable.
  const thinkingConfig = { disabled: {}, enabled: { efforts: { low: {}, medium: {}, high: {} } } };

  /** Builds a body whose only variable is omp's `reasoning` option. */
  function bodyFor(reasoning: unknown): unknown {
    mockedGetCachedModelConfig.mockReturnValue({
      key: "ultimate",
      is_reasoning: true,
      max_output_tokens: 32768,
      source: "system",
      thinking_config: thinkingConfig,
    });
    return decodeQoderBody(
      buildChatRequest({
        model,
        context,
        options: { sessionId: "sess-9", reasoning } as unknown as SimpleStreamOptions,
        providerMode: "qoder",
        identity,
      }).encodedBytes,
    );
  }

  function parametersFor(reasoning: unknown): Record<string, unknown> {
    return objectField(bodyFor(reasoning), "parameters") as Record<string, unknown>;
  }

  it("sends the explicit effort on the wire, in the official key order", () => {
    const parameters = parametersFor("high");
    expect(Object.keys(parameters)).toEqual(["max_tokens", "reasoning_effort", "enable_thinking"]);
    expect(parameters.reasoning_effort).toBe("high");
    expect(parameters.enable_thinking).toBe(true);
  });

  it("turns thinking off through parameters", () => {
    // omp hands `--thinking off` over as the "off" token, which is a
    // ModelThinkingLevel rather than the narrower declared ThinkingLevel.
    const parameters = parametersFor("off");
    expect(parameters.reasoning_effort).toBe("none");
    expect(parameters.enable_thinking).toBe(false);
    expect(Object.keys(parameters)).not.toContain("reasoning_budget_tokens");
  });

  it("reports is_reasoning false for the turn that switched thinking off", () => {
    // `pretty.mjs:132119`, which `pretty.mjs:132122` then mirrors into
    // chat_context. The catalog entry above says is_reasoning: true.
    const extra = objectField(objectField(bodyFor("off"), "chat_context"), "extra");
    expect(field(objectField(extra, "modelConfig"), "is_reasoning")).toBe(false);
  });

  it("folds minimal into low", () => {
    // omp's lowest level has no counterpart in the official vocabulary
    // (`pretty.mjs:85158-85166`).
    expect(parametersFor("minimal").reasoning_effort).toBe("low");
  });

  it("ignores a value outside the official vocabulary", () => {
    expect(Object.keys(parametersFor("wat"))).toEqual(["max_tokens"]);
  });

  it("never sends thinking_config or thinking_effort", () => {
    // The regression fence for ledger rows 19 and 21. The cached entry above does
    // carry a thinking_config, so this also pins that model_config is rebuilt from
    // the official ten keys (`pretty.mjs:132131`) instead of forwarding the cached
    // object verbatim.
    for (const reasoning of [undefined, "high", "off"]) {
      const wire = JSON.stringify(bodyFor(reasoning));
      expect(wire).not.toContain("thinking_config");
      expect(wire).not.toContain("thinking_effort");
    }
  });

  it("turns thinking off through the harness's disableReasoning flag", () => {
    // The current harness does not put "off" into `reasoning`: it sends
    // `reasoning: undefined` plus `disableReasoning: true` (a newer
    // SimpleStreamOptions field than the declared provider type). Ignoring the
    // flag left thinking on at the server's default effort.
    mockedGetCachedModelConfig.mockReturnValue({
      key: "dfmodel",
      is_reasoning: true,
      max_output_tokens: 32768,
      source: "system",
      thinking_config: { enabled: { efforts: { high: {}, max: { is_default: true }, low: {} } } },
    });
    const body = decodeQoderBody(
      buildChatRequest({
        model,
        context,
        options: { disableReasoning: true } as unknown as SimpleStreamOptions,
        providerMode: "qoder",
        identity,
      }).encodedBytes,
    );
    const parameters = objectField(body, "parameters") as Record<string, unknown>;
    expect(parameters.reasoning_effort).toBe("none");
    expect(parameters.enable_thinking).toBe(false);
  });
});

// --- the catalog's thinking capability, projected for omp's pi fork --------
// A model's `thinking_config.enabled.efforts` is authoritative. It feeds the
// fork's `thinking: { mode: "effort", efforts, defaultLevel }` block, whose
// menu IS the efforts list -- a model without the block exposes no levels at
// all. The provider's request builder screens raw levels against the same
// rungs: minimal snaps onto the lowest rung, xhigh onto the highest, and a
// level with no rung leaves the reasoning keys off the wire.
describe("thinkingFor", () => {
  // dfmodel's actual catalog shape, keys in the arbitrary JSON order the cache
  // file happens to store them in.
  const dfmodel = {
    key: "dfmodel",
    thinking_config: { enabled: { efforts: { high: {}, max: { is_default: true }, low: {} } } },
  };

  it("projects the catalog entry for omp's fork", () => {
    expect(thinkingFor(dfmodel)).toEqual({
      efforts: ["low", "high", "max"],
      defaultLevel: "max",
    });
  });

  it("omits defaultLevel when no effort carries is_default", () => {
    expect(thinkingFor({ key: "x", thinking_config: { enabled: { efforts: { low: {}, high: {} } } } })).toEqual({
      efforts: ["low", "high"],
    });
  });

  it("sorts a partial ladder into ladder order", () => {
    // dmodel offers only high and max.
    expect(thinkingFor({ key: "dmodel", thinking_config: { enabled: { efforts: { max: {}, high: {} } } } })).toEqual({
      efforts: ["high", "max"],
    });
  });

  it("keeps xhigh and max as distinct rungs on full-ladder models", () => {
    // Full-ladder models offer BOTH xhigh and max; they must stay separate
    // menu entries, or picking xhigh would silently request max.
    expect(
      thinkingFor({
        key: "ultimate",
        thinking_config: {
          enabled: { efforts: { low: {}, medium: {}, high: {}, xhigh: {}, max: { is_default: true } } },
        },
      }),
    ).toEqual({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "max",
    });
  });

  it("returns undefined when the catalog declares no efforts", () => {
    // On/off-only models (qmodel, qmodel_latest) and the cache-miss fallback
    // have no effort list to expose.
    expect(thinkingFor({ key: "qmodel", thinking_config: { enabled: {} } })).toBeUndefined();
    expect(thinkingFor({ key: "qmodel", thinking_config: { enabled: { efforts: {} } } })).toBeUndefined();
    expect(thinkingFor(null)).toBeUndefined();
  });

  it("ignores effort keys outside the official vocabulary", () => {
    // The catalog is remote data; an unexpected effort key must not become a
    // rung -- not in the efforts list, not as defaultLevel.
    expect(
      thinkingFor({ key: "x", thinking_config: { enabled: { efforts: { high: {}, ultra: { is_default: true } } } } }),
    ).toEqual({
      efforts: ["high"],
    });
  });
});

describe("buildChatRequest maps the thinking level through the catalog's rungs", () => {
  beforeEach(() => {
    mockedGetCachedModelConfig.mockReset();
  });

  function parametersFor(reasoning: string): Record<string, unknown> {
    mockedGetCachedModelConfig.mockReturnValue({
      key: "dfmodel",
      is_reasoning: true,
      max_output_tokens: 32768,
      source: "system",
      thinking_config: { enabled: { efforts: { high: {}, max: { is_default: true }, low: {} } } },
    });
    return objectField(
      decodeQoderBody(
        buildChatRequest({
          model,
          context,
          options: { reasoning } as unknown as SimpleStreamOptions,
          providerMode: "qoder",
          identity,
        }).encodedBytes,
      ),
      "parameters",
    ) as Record<string, unknown>;
  }

  it("sends the model's own rung for each supported level", () => {
    expect(parametersFor("low").reasoning_effort).toBe("low");
    expect(parametersFor("high").reasoning_effort).toBe("high");
  });

  it("rides xhigh on the model's highest rung", () => {
    expect(parametersFor("xhigh").reasoning_effort).toBe("max");
  });

  it("folds minimal to the model's lowest rung", () => {
    expect(parametersFor("minimal").reasoning_effort).toBe("low");
  });

  it("drops an unsupported level to the official default path", () => {
    // medium has no rung on dfmodel. The harness's clampThinkingLevel snaps it
    // before it reaches the provider; a raw medium arriving anyway must not go
    // on the wire as an effort the model has no slot for.
    expect(Object.keys(parametersFor("medium"))).toEqual(["max_tokens"]);
  });

  it("passes a raw max token through untouched", () => {
    // dfmodel has a max rung, so the token rides through as its own rung.
    expect(parametersFor("max").reasoning_effort).toBe("max");
  });

  it("keeps the off path independent of the rungs", () => {
    const parameters = parametersFor("off");
    expect(parameters.reasoning_effort).toBe("none");
    expect(parameters.enable_thinking).toBe(false);
  });
});

describe("clampMaxTokens screens a cap the way the official client does", () => {
  it("keeps a positive safe integer", () => {
    expect(clampMaxTokens(8192)).toBe(8192);
  });

  it("parses a numeric string", () => {
    // The cache holds whatever the server sent, and the official helper accepts a
    // string cap (`pretty.mjs:105459`).
    expect(clampMaxTokens("4096")).toBe(4096);
  });

  // Everything the official helper rejects lands on 32000 (`pretty.mjs:105460`).
  const rejected: Array<[string, unknown]> = [
    ["0", 0],
    ["a negative cap", -1],
    ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a blank string", "   "],
    ["a non-numeric string", "many"],
    ["a fraction", 1.5],
    ["a cap past MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 2],
  ];
  for (const [label, value] of rejected) {
    it(`falls back to 32000 for ${label}`, () => {
      expect(clampMaxTokens(value)).toBe(32000);
    });
  }
});

describe("buildModelConfig builds the official model_config", () => {
  // `pretty.mjs:132131` builds this object field by field. Handing the catalog
  // entry over instead put every field the server ships -- including ones it
  // starts shipping later -- back onto the wire.
  const entry = {
    key: "ultimate",
    display_name: "Ultimate",
    format: "anthropic",
    is_vl: true,
    is_reasoning: false,
    source: "service",
    max_input_tokens: 1_000_000,
    max_output_tokens: 65_536,
    thinking_config: { enabled: { efforts: {} } },
    server_scene: "assistant",
    a_field_the_server_added_later: 1,
  };
  const officialKeys = [
    "key",
    "display_name",
    "model",
    "format",
    "is_vl",
    "is_reasoning",
    "api_key",
    "url",
    "source",
    "max_input_tokens",
  ];

  it("sends exactly these model_config keys, in this order", () => {
    expect(Object.keys(buildModelConfig(entry, "ultimate", true))).toEqual(officialKeys);
  });

  it("sends exactly these model_config keys, in this order, with no catalog entry", () => {
    // The toEqual assertions below ignore key order, and the encoded body is
    // signed, so the no-entry path needs its own order assertion.
    expect(Object.keys(buildModelConfig(undefined, "qmodel", false))).toEqual(officialKeys);
  });

  it("reads the official fields off the catalog entry", () => {
    // is_reasoning comes from the argument, not the entry: a turn with thinking
    // switched off reports false whatever the catalog claims
    // (`pretty.mjs:132119`), so the fixture entry disagrees with the argument here.
    expect(buildModelConfig(entry, "ultimate", true)).toEqual({
      key: "ultimate",
      display_name: "Ultimate",
      model: "",
      format: "anthropic",
      is_vl: true,
      is_reasoning: true,
      api_key: "",
      url: "",
      source: "service",
      max_input_tokens: 1_000_000,
    });
  });

  it("drops every entry field outside the official shape", () => {
    const built = buildModelConfig(entry, "ultimate", true);
    expect(built).not.toHaveProperty("thinking_config");
    expect(built).not.toHaveProperty("max_output_tokens");
    expect(built).not.toHaveProperty("server_scene");
    expect(built).not.toHaveProperty("a_field_the_server_added_later");
  });

  it("falls back to the model id and the official defaults with no entry", () => {
    expect(buildModelConfig(undefined, "qmodel", false)).toEqual({
      key: "qmodel",
      display_name: "qmodel",
      model: "",
      format: "openai",
      is_vl: false,
      is_reasoning: false,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 200000,
    });
  });

  it("treats a null entry like a missing one", () => {
    // getCachedModelConfig hands back null, not undefined, on a cache miss.
    expect(buildModelConfig(null, "qmodel", false)).toEqual(buildModelConfig(undefined, "qmodel", false));
  });

  it("fills each missing field independently on a partial entry", () => {
    expect(buildModelConfig({ max_output_tokens: 65_536 }, "kmodel", true)).toEqual({
      key: "kmodel",
      display_name: "kmodel",
      model: "",
      format: "openai",
      is_vl: false,
      is_reasoning: true,
      api_key: "",
      url: "",
      source: "system",
      max_input_tokens: 200000,
    });
  });

  it("defaults display_name to the entry key rather than the model id", () => {
    const built = buildModelConfig({ key: "cached-key" }, "requested-id", false);
    expect(built.key).toBe("cached-key");
    expect(built.display_name).toBe("cached-key");
  });
});
