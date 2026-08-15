import { expect, it, vi } from "vitest";
import type * as CosyModule from "../cosy.js";
import { identityFromCredentials, resolveQoderIdentity, resolveQoderSigningIdentity } from "../oauth.js";

// getMachineId is the only identity helper with a side effect: it can write
// `qoder-machine-id` into omp's agent directory. Faking just that one export
// lets us assert which paths reach it; everything else in cosy.js stays real, so
// the expected placeholder strings below come from the real qoderIdentityDefaults.
const getMachineId = vi.hoisted(() => vi.fn(() => "fake-machine-id"));

vi.mock("../cosy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CosyModule>()),
  getMachineId,
}));

// The credential store is injected rather than read from disk: getCachedCredentials
// goes through omp's AuthStorage, and faking it also lets us count the reads.
const authGet = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => ({ get: authGet, set: vi.fn() }) },
}));

// The identity file is the other source getCachedCredentials merges in. This
// test covers the credential side, so it stays empty and the fallbacks below
// exercise the `||` chains rather than the file.
vi.mock("../identity-store.js", () => ({
  loadQoderIdentity: () => null,
  saveQoderIdentity: vi.fn(),
}));

const AUTH_STORE: Record<string, Record<string, string>> = {
  "blank-machine-id": { access: "job-token", userID: "", name: "", email: "", machineID: "" },
  "populated-creds": {
    access: "job-token",
    userID: "u-42",
    name: "Real Name",
    email: "real@example.com",
    machineID: "stored-machine-id",
  },
};

authGet.mockImplementation((provider: string) => AUTH_STORE[provider]);

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
  authGet.mockClear();
  expect(resolveQoderSigningIdentity(absent, "cn")).toEqual({
    userID: "qoder-user",
    name: "Qoder CN User",
    email: "user@qoder.com.cn",
    machineID: "fake-machine-id",
  });
  expect(getMachineId).toHaveBeenCalledTimes(1);
  expect(authGet).toHaveBeenCalledTimes(1);

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

it("recovers userID and machineID from the refresh string omp cannot strip", () => {
  // omp persists only access/refresh/expires/email, dropping the userID and
  // machineID this provider attaches. For an OAuth credential they survive in
  // the refresh string's `<token>|<userID>|<machineID>` tail; without reading it
  // back, COSY signing would throw "user id is empty" on every request.
  AUTH_STORE["tail-only"] = { access: "job-token", refresh: "rt|u-77|machine-77" };

  expect(resolveQoderSigningIdentity("tail-only", "global")).toEqual({
    userID: "u-77",
    // Not recoverable from the tail, so these stay placeholders — which is
    // exactly why buildAuthHeaders tolerates an empty name and email but not an
    // empty userID.
    name: "Qoder User",
    email: "user@qoder.com",
    machineID: "machine-77",
  });
});

it("recovers identity from a PAT refresh string too", () => {
  // A PAT credential's refresh field is
  // `pat|<pat>|<jobRefresh>|<userID>|<machineID>` — a different layout from the
  // OAuth one, and the shape omp actually stores after a PAT login. Reading only
  // the OAuth layout would leave userID empty and break COSY signing outright.
  AUTH_STORE["pat-cred"] = {
    access: "jt-job-token",
    refresh: "pat|pt-personal|jrt-jobrefresh|u-99|machine-99",
  };

  expect(resolveQoderSigningIdentity("pat-cred", "global")).toEqual({
    userID: "u-99",
    name: "Qoder User",
    email: "user@qoder.com",
    machineID: "machine-99",
  });
});
