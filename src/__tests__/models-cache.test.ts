import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModels, updateQoderModelsCache } from "../models.js";

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
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => TEST_HOME };
});

const CACHE_PATH = join(TEST_HOME, ".pi", "agent", "qoder-models-cache.json");

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
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "auto", enable: false, display_name: "Auto" },
              { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "performance", enable: false, display_name: "Performance" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com", "global");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["ultimate", "lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "cmodel", enable: true, display_name: "Cantus" }] }),
      }),
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
});
