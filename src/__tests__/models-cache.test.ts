import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModels, updateQoderModelsCache } from "../models.js";
import { qoderEncodeBody } from "../qoder-encoding.js";

/**
 * `models.ts` 读 `response.text()` 再走 `parseQoderJsonBody`，因为官方对目录响应
 * 过一遍 decrypt_server_response（台账差异第 40 行），而 `json()` 遇到编码过的
 * 正文会抛且把 body 消费掉。这个替身按真实 `Response` 提供 `text()`。
 */
function jsonResponse(body: unknown) {
  return { ok: true, text: () => Promise.resolve(JSON.stringify(body)) };
}

/** 同上，但正文是 Qoder 的混淆编码形式，用来验证解码路径真的接上了。 */
function encodedResponse(body: unknown) {
  return { ok: true, text: () => Promise.resolve(qoderEncodeBody(JSON.stringify(body))) };
}

// `src/models.ts` resolves the cache path from `homedir()`, so the home
// directory is redirected before any import is evaluated: `vi.hoisted` runs
// first and `vi.mock` is hoisted with it. HOME/USERPROFILE are set as well so
// code resolving the home directory natively sees the same directory.
// This file owns its own temp home, separate from oauth.test.ts, so the two
// files cannot race each other when vitest runs them in parallel.
const TEST_HOME = await vi.hoisted(async () => {
  // Dynamic imports: this callback runs before the static imports above are
  // initialised, which is the whole point of hoisting it.
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "qoder-models-cache-test-"));
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // `agentPath` honors PI_CODING_AGENT_DIR; a value inherited from the
  // developer's shell would send the cache outside this temp home.
  delete process.env.PI_CODING_AGENT_DIR;
  return home;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => TEST_HOME };
});

const CACHE_PATH = join(TEST_HOME, ".omp", "agent", "qoder-models-cache.json");

beforeEach(() => {
  // Start from no cache file. It lives in this file's temp home, so there is
  // nothing real to snapshot or restore.
  rmSync(CACHE_PATH, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("Qoder model cache", () => {
  it("keeps only enabled service models without adding auto as a fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chat: [
            { key: "auto", enable: false, display_name: "Auto" },
            { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
            { key: "lite", enable: true, display_name: "Lite" },
            { key: "performance", enable: false, display_name: "Performance" },
          ],
        }),
      ),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["ultimate", "lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ chat: [{ key: "cmodel", enable: true, display_name: "Cantus" }] })),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["cmodel"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );

    expect(getCachedModels("global").map((model) => model.id)).toEqual(["ultimate"]);
  });

  it("keeps entries without an explicit enable flag (dogfood/crit models)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chat: [
            { key: "qwen3.8-v120-dogfood-crit", display_name: "Peach-07-17-DogFooding" },
            { key: "disabled-entry", enable: false, display_name: "Disabled" },
          ],
        }),
      ),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["qwen3.8-v120-dogfood-crit"]);
  });

  it("prefers the assistant scene over chat (qodercli default scene)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chat: [{ key: "dfmodel", enable: true, display_name: "DeepSeek-V4-Flash" }],
          assistant: [
            { key: "dfmodel", enable: true, display_name: "DeepSeek-V4-Flash" },
            { key: "qwen3.8-v120-dogfood-crit", display_name: "Peach-07-17-DogFooding" },
          ],
        }),
      ),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["dfmodel", "qwen3.8-v120-dogfood-crit"]);
  });

  // Ledger row 41: official merges EVERY scene into one catalog (config scene
  // first and winning on duplicate keys), merges byok_enterprise into the config
  // scene, and warns — not fails — when the config scene is absent.
  describe("cross-scene merge (ledger row 41)", () => {
    it("merges entries from every scene, not just the configured one", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            assistant: [{ key: "ultimate", enable: true }],
            quest: [{ key: "quest-auto", enable: true }],
            nap: [{ key: "nap-auto", enable: true }],
          }),
        ),
      );

      await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      expect(cache.models.map((m: { id: string }) => m.id)).toEqual(["ultimate", "quest-auto", "nap-auto"]);
      // The origin scene is recorded on the stored config entry.
      expect(cache.configs["quest-auto"].server_scene).toBe("quest");
      expect(cache.configs.ultimate.server_scene).toBe("assistant");
    });

    it("lets the configured scene win when another scene carries the same key", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            assistant: [{ key: "cmodel", enable: true, display_name: "FromAssistant" }],
            qwake: [
              { key: "cmodel", enable: true, display_name: "FromQwake" },
              { key: "safety", enable: true },
            ],
          }),
        ),
      );

      await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      expect(cache.models.map((m: { id: string }) => m.id)).toEqual(["cmodel", "safety"]);
      expect(cache.models.find((m: { id: string }) => m.id === "cmodel").name).toBe("FromAssistant");
      expect(cache.configs.cmodel.server_scene).toBe("assistant");
    });

    it("merges byok_enterprise entries into the configured scene with their origin marked", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            assistant: [{ key: "ultimate", enable: true }],
            byok_enterprise: [
              { key: "ultimate", enable: true, display_name: "Shadowed" }, // dup of an assistant key
              { key: "qwen3.8-v120-dogfood-crit", enable: true },
            ],
          }),
        ),
      );

      await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      // The duplicate byok key is skipped; the unique one is merged in once.
      expect(cache.models.map((m: { id: string }) => m.id)).toEqual(["ultimate", "qwen3.8-v120-dogfood-crit"]);
      expect(cache.configs["qwen3.8-v120-dogfood-crit"].server_scene).toBe("byok_enterprise");
    });

    it("warns instead of failing when the configured scene is missing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ chat: [{ key: "cmodel", enable: true }] })));

      await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");
      warn.mockRestore();

      const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      expect(cache.models.map((m: { id: string }) => m.id)).toEqual(["cmodel"]);
    });
  });

  // 台账差异第 40 行：官方对目录响应无条件过一遍解密。这条用编码后的正文喂进去，
  // 证明解码真的接在了生产路径上，而不只是 qoder-encoding.ts 里的一个纯函数。
  it("reads a catalog response that arrived in the obfuscated form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        encodedResponse({
          assistant: [{ key: "emodel", enable: true, display_name: "Encoded" }],
        }),
      ),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["emodel"]);
  });
});
