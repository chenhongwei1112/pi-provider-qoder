import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateQoderModelsCache } from "../models.js";
import { autoLoginQoderFromEnvironment, getCachedCredentials, getQoderPatForMode } from "../oauth.js";
import { credentialsFromPat } from "../pat.js";

// The production code resolves `~/.pi/agent/auth.json` at module top level
// (`src/oauth.ts`), so the home directory has to be redirected before any
// import is evaluated: `vi.hoisted` runs first, `vi.mock` is hoisted with it.
// The mock covers every `node:os` importer inside the module graph; setting
// HOME/USERPROFILE covers code that resolves the home directory natively
// (e.g. pi's own externalized `AuthStorage`).
// This file owns its own temp home so it can never race models-cache.test.ts.
const TEST_HOME = await vi.hoisted(async () => {
  // Dynamic imports: this callback runs before the static imports above are
  // initialised, which is the whole point of hoisting it.
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "qoder-oauth-test-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => TEST_HOME };
});

const AUTH_FILE = join(TEST_HOME, ".pi", "agent", "auth.json");

vi.mock("../pat.js", () => ({
  credentialsFromPat: vi.fn().mockResolvedValue({
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3600000,
    userID: "mock-user-123",
    email: "test@example.com",
    name: "Test User",
    machineID: "mock-machine-id",
    type: "oauth",
  }),
  isPatRefresh: vi.fn().mockReturnValue(false),
  decodePatRefresh: vi.fn(),
}));

vi.mock("../models.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
}));

describe("oauth autoLoginQoderFromEnvironment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Each test starts from an empty auth store in this file's temp home. No
    // snapshot/restore of a real credentials file is needed any more.
    rmSync(AUTH_FILE, { force: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("extracts PAT correctly from env for global and CN mode", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    expect(getQoderPatForMode("global")).toBe("pt-global-123");

    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn-456";
    expect(getQoderPatForMode("cn")).toBe("pt-cn-456");
  });

  it("does nothing if no PAT in environment", async () => {
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");
    expect(getCachedCredentials("mock-token", "qoder-test-provider")).toBeNull();
  });

  it("re-exchanges an environment PAT even when cached credentials exist", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth["qoder-test-provider"] = {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", "global");
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      "global",
    );
  });
});
