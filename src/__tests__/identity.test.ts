import { expect, it, vi } from "vitest";
import type * as CosyModule from "../cosy.js";
import { identityFromCredentials, resolveQoderIdentity, resolveQoderSigningIdentity } from "../oauth.js";

// Only getMachineId is faked; everything else in cosy.js stays real. getMachineId
// is the one identity helper with a side effect: it can write
// ~/.pi/agent/qoder-machine-id. Spying on it pins "the extension-load path never
// touches the machine id file" without mocking node:fs.
const getMachineId = vi.hoisted(() => vi.fn(() => "fake-machine-id"));

vi.mock("../cosy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CosyModule>()),
  getMachineId,
}));

it("only the signing path resolves machineID", () => {
  // A provider that is never in auth.json, so getCachedCredentials returns null
  // and machineID can only come from getMachineId.
  const absent = "qoder-provider-absent-from-auth-store";

  identityFromCredentials(null, "global");
  identityFromCredentials({ userID: "u", name: "n", email: "e" }, "cn");
  const loaded = resolveQoderIdentity(absent, "global");

  expect(getMachineId).not.toHaveBeenCalled();
  expect(loaded).toEqual({ userID: "qoder-user", name: "Qoder User", email: "user@qoder.com" });
  expect("machineID" in loaded).toBe(false);

  expect(resolveQoderSigningIdentity(absent, "cn")).toEqual({
    userID: "qoder-user",
    name: "Qoder CN User",
    email: "user@qoder.com.cn",
    machineID: "fake-machine-id",
  });
  expect(getMachineId).toHaveBeenCalledTimes(1);
});
