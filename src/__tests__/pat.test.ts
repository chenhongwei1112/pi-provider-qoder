import { describe, expect, it, vi } from "vitest";
import { credentialsFromPat, decodePatRefresh, encodePatRefresh, isPatRefresh, PAT_REFRESH_PREFIX } from "../pat.js";

// ── isPatRefresh ──────────────────────────────────────────────────────────

describe("isPatRefresh", () => {
  it("returns true for PAT refresh strings", () => {
    expect(isPatRefresh("pat|mytoken|refresh123|user1|machine1")).toBe(true);
  });

  it("returns true for minimal PAT prefix", () => {
    expect(isPatRefresh("pat|")).toBe(true);
  });

  it("returns false for non-PAT refresh strings", () => {
    expect(isPatRefresh("some-other-refresh-token")).toBe(false);
    expect(isPatRefresh("refresh|user|machine")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPatRefresh("")).toBe(false);
  });
});

// ── encodePatRefresh / decodePatRefresh ───────────────────────────────────

describe("encodePatRefresh / decodePatRefresh roundtrip", () => {
  it("encodes and decodes correctly", () => {
    const encoded = encodePatRefresh("pt-abc123", "jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("pat|pt-abc123|jrt-xyz|user-42|machine-7");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "pt-abc123",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
    });
  });

  it("handles empty fields", () => {
    const encoded = encodePatRefresh("", "", "", "");
    expect(encoded).toBe("pat||||");

    const decoded = decodePatRefresh(encoded);
    expect(decoded).toEqual({
      pat: "",
      jobRefreshToken: "",
      userID: "",
      machineID: "",
    });
  });

  it("handles pipe characters in fields gracefully", () => {
    // The decode splits on |, so extra pipes shift fields
    const encoded = encodePatRefresh("pt-test", "jrt-ok", "u1", "m1");
    const decoded = decodePatRefresh(encoded);
    expect(decoded.pat).toBe("pt-test");
    expect(decoded.jobRefreshToken).toBe("jrt-ok");
    expect(decoded.userID).toBe("u1");
    expect(decoded.machineID).toBe("m1");
  });
});

describe("PAT_REFRESH_PREFIX", () => {
  it('is "pat"', () => {
    expect(PAT_REFRESH_PREFIX).toBe("pat");
  });
});

// ── credentialsFromPat: userinfo alias handling ────────────────────────────

/**
 * 台账差异第 49 行：官方读 `id` / `user_id` / `uid` 三个别名当 uid，插件此前只读
 * `id`，服务端返回另两个之一时 `userID` 会是空串，随后 `buildAuthHeaders` 抛
 * `cosy: user id is empty`。这里逐个别名验证。
 */
describe("credentialsFromPat resolves the uid alias the server actually sent", () => {
  function stubExchangeThenUserInfo(userInfoBody: unknown) {
    let call = 0;
    return vi.fn().mockImplementation(() => {
      call += 1;
      // 第一次是 jobToken 交换，第二次是 userinfo。
      const body = call === 1 ? { token: "jt-abc", refresh_token: "jrt-abc", expires_in: 3600 } : userInfoBody;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });
  }

  it.each([["id"], ["user_id"], ["uid"]])("reads the uid from %s", async (field) => {
    vi.stubGlobal("fetch", stubExchangeThenUserInfo({ [field]: "user-99", email: "e@x.com" }));
    const creds = await credentialsFromPat("pt-token", "global");
    expect(creds.userID).toBe("user-99");
    vi.unstubAllGlobals();
  });

  it.each([["name"], ["username"], ["user_name"]])("reads the display name from %s", async (field) => {
    vi.stubGlobal("fetch", stubExchangeThenUserInfo({ id: "user-99", [field]: "Ada" }));
    const creds = await credentialsFromPat("pt-token", "global");
    expect(creds.name).toBe("Ada");
    vi.unstubAllGlobals();
  });
});
