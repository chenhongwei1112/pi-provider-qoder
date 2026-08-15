import { expect, it, vi } from "vitest";
import type * as CosyModule from "../cosy.js";
import { identityFromCredentials, resolveQoderIdentity, resolveQoderSigningIdentity } from "../oauth.js";

// getMachineId is the only identity helper with a side effect: it can write
// ~/.pi/agent/qoder-machine-id. Faking just that one export lets us assert which
// paths reach it; everything else in cosy.js stays real, so the expected
// placeholder strings below come from the real qoderIdentityDefaults.
const getMachineId = vi.hoisted(() => vi.fn(() => "fake-machine-id"));

vi.mock("../cosy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CosyModule>()),
  getMachineId,
}));

// The auth store is injected rather than read from disk: the real
// ~/.pi/agent/auth.json is also written by oauth.test.ts, and this file must not
// race it. Faking the two readers also lets us count how often the store is read.
const AUTH_STORE = {
  "blank-machine-id": { access: "job-token", userID: "", name: "", email: "", machineID: "" },
  "populated-creds": {
    access: "job-token",
    userID: "u-42",
    name: "Real Name",
    email: "real@example.com",
    machineID: "stored-machine-id",
  },
};

const existsSync = vi.hoisted(() => vi.fn(() => true));
const readFileSync = vi.hoisted(() => vi.fn(() => "{}"));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync,
  readFileSync,
}));

readFileSync.mockReturnValue(JSON.stringify(AUTH_STORE));

it("only the signing path resolves machineID", () => {
  // "absent" is not a key of AUTH_STORE, so getCachedCredentials returns null and
  // machineID could only come from getMachineId.
  const absent = "provider-absent-from-auth-store";

  // Both directions of every `||` in identityFromCredentials. Only the defaults
  // case used to be asserted, and it is identical under a body that ignores
  // `creds` altogether — so signing as the placeholder user went unnoticed.
  expect(identityFromCredentials(null, "global")).toEqual({
    userID: "qoder-user",
    name: "Qoder User",
    email: "user@qoder.com",
  });
  expect(identityFromCredentials({ userID: "u", name: "n", email: "e" }, "cn")).toEqual({
    userID: "u",
    name: "n",
    email: "e",
  });
  const loaded = resolveQoderIdentity(absent, "global");

  expect(getMachineId).not.toHaveBeenCalled();
  expect(loaded).toEqual({ userID: "qoder-user", name: "Qoder User", email: "user@qoder.com" });
  expect("machineID" in loaded).toBe(false);

  // The signing path resolves it, reading the auth store exactly once.
  readFileSync.mockClear();
  expect(resolveQoderSigningIdentity(absent, "cn")).toEqual({
    userID: "qoder-user",
    name: "Qoder CN User",
    email: "user@qoder.com.cn",
    machineID: "fake-machine-id",
  });
  expect(getMachineId).toHaveBeenCalledTimes(1);
  expect(readFileSync).toHaveBeenCalledTimes(1);

  // An empty-string machineID must fall back too: `||`, never `??`.
  expect(resolveQoderSigningIdentity("blank-machine-id", "global")).toEqual({
    userID: "qoder-user",
    name: "Qoder User",
    email: "user@qoder.com",
    machineID: "fake-machine-id",
  });

  // ...and a stored machineID must be used, not regenerated: the primary
  // direction of `creds?.machineID || getMachineId()`, which no store entry
  // used to reach. Dropping `creds?.machineID` left the suite green.
  expect(resolveQoderSigningIdentity("populated-creds", "global")).toEqual({
    userID: "u-42",
    name: "Real Name",
    email: "real@example.com",
    machineID: "stored-machine-id",
  });
  expect(getMachineId, "a stored machineID must not trigger the writing fallback").toHaveBeenCalledTimes(2);
});
