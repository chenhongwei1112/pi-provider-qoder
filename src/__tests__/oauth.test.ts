import { rmSync } from "node:fs";
import type * as NodeOs from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateQoderModelsCache } from "../models.js";
import { autoLoginQoderFromEnvironment, getCachedCredentials, getQoderPatForMode } from "../oauth.js";
import { credentialsFromPat } from "../pat.js";

// The identity file and the model cache both resolve under omp's agent
// directory, so the home directory has to be redirected before any import is
// evaluated: `vi.hoisted` runs first and `vi.mock` is hoisted with it. The mock
// covers every `node:os` importer inside the module graph; setting
// HOME/USERPROFILE covers code that resolves the home directory natively.
// This file owns its own temp home so it can never race models-cache.test.ts.
const TEST_HOME = await vi.hoisted(async () => {
  // Dynamic imports: this callback runs before the static imports above are
  // initialised, which is the whole point of hoisting it.
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "qoder-oauth-test-"));
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // `agentPath` honors PI_CODING_AGENT_DIR; a value inherited from the
  // developer's shell would move the identity file out of this temp home.
  delete process.env.PI_CODING_AGENT_DIR;
  return home;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => TEST_HOME };
});

// omp's AuthStorage is faked so the credential write lands somewhere observable
// instead of the real SQLite store. The Map backs both directions, which lets a
// test seed an existing credential and then assert what replaced it.
const authStore = vi.hoisted(() => new Map<string, unknown>());
const authGet = vi.hoisted(() => vi.fn());
const authSet = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => ({ get: authGet, set: authSet }) },
}));

authGet.mockImplementation((provider: string) => authStore.get(provider));
authSet.mockImplementation((provider: string, credential: unknown) => {
  authStore.set(provider, credential);
});

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
    // Each test starts from an empty credential store.
    authStore.clear();
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

    expect(authSet).not.toHaveBeenCalled();
    expect(getCachedCredentials("qoder-test-provider", "global")).toBeNull();
  });

  it("re-exchanges an environment PAT even when a credential is already stored", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";
    authStore.set("qoder-test-provider", {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
    });

    await autoLoginQoderFromEnvironment("qoder-test-provider", "global");

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", "global");
    // The freshly exchanged credential must replace the stored one, not sit
    // beside it: the whole point of re-exchanging on startup.
    expect(authSet).toHaveBeenCalledWith(
      "qoder-test-provider",
      expect.objectContaining({ access: "mock-access-token", userID: "mock-user-123" }),
    );
    expect(getCachedCredentials("qoder-test-provider", "global")?.access).toBe("mock-access-token");
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      "global",
    );
  });
});
