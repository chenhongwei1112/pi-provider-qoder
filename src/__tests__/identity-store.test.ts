import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadQoderIdentity, saveQoderIdentity } from "../identity-store.js";

// `PI_CODING_AGENT_DIR` is the documented way to relocate omp's agent directory,
// so pointing it at a temp dir both isolates this file and covers that contract.
// `agentPath` reads the variable on every call, so no module mock is needed.
const AGENT_DIR = mkdtempSync(join(tmpdir(), "qoder-identity-store-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const IDENTITY_FILE = join(AGENT_DIR, "qoder-identity.json");
const CN_IDENTITY_FILE = join(AGENT_DIR, "qoder-cn-identity.json");

beforeEach(() => {
  rmSync(IDENTITY_FILE, { force: true });
  rmSync(CN_IDENTITY_FILE, { force: true });
});

afterAll(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("Qoder identity store", () => {
  it("round-trips an identity", () => {
    saveQoderIdentity("global", { userID: "u-1", name: "Real Name", email: "a@b.c", machineID: "m-1" });

    expect(loadQoderIdentity("global")).toEqual({
      userID: "u-1",
      name: "Real Name",
      email: "a@b.c",
      machineID: "m-1",
    });
  });

  it("returns null when nothing was stored", () => {
    expect(loadQoderIdentity("global")).toBeNull();
  });

  it("keeps a stored value when a later write carries an empty one", () => {
    // A refresh reads `name` back from a credential omp already stripped it
    // from, so it routinely arrives as "". Writing that through would erase the
    // real name captured at login — the reason saveQoderIdentity prunes falsy
    // fields instead of spreading them.
    saveQoderIdentity("global", { userID: "u-1", name: "Real Name" });
    saveQoderIdentity("global", { userID: "u-1", name: "" });

    expect(loadQoderIdentity("global")?.name).toBe("Real Name");
  });

  it("merges later fields into the stored identity", () => {
    saveQoderIdentity("global", { userID: "u-1" });
    saveQoderIdentity("global", { machineID: "m-1" });

    expect(loadQoderIdentity("global")).toEqual({ userID: "u-1", machineID: "m-1" });
  });

  it("writes nothing when every field is empty", () => {
    saveQoderIdentity("global", { userID: "", name: "", email: "", machineID: "" });

    expect(loadQoderIdentity("global")).toBeNull();
  });

  it("keeps the global and CN identities apart", () => {
    saveQoderIdentity("global", { userID: "global-user" });
    saveQoderIdentity("cn", { userID: "cn-user" });

    expect(loadQoderIdentity("global")?.userID).toBe("global-user");
    expect(loadQoderIdentity("cn")?.userID).toBe("cn-user");
  });

  it("writes under PI_CODING_AGENT_DIR", () => {
    saveQoderIdentity("global", { userID: "u-1" });

    expect(JSON.parse(readFileSync(IDENTITY_FILE, "utf8"))).toEqual({ userID: "u-1" });
  });
});
