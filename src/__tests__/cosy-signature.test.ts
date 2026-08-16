import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAuthHeaders, computeCosySignature, computeSigPath, resetRuntimeAuthCache } from "../cosy.js";

describe("computeSigPath", () => {
  it("strips the /algo prefix the gateway adds", () => {
    expect(computeSigPath("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1")).toBe("/api/v2/model/list");
  });

  it("drops the query string", () => {
    expect(
      computeSigPath(
        "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&Encode=1",
      ),
    ).toBe("/api/v2/service/pro/sse/agent_chat_generation");
  });

  it("leaves a path that has no /algo prefix alone", () => {
    expect(computeSigPath("https://openapi.qoder.sh/api/v1/userinfo")).toBe("/api/v1/userinfo");
  });
});

describe("computeCosySignature", () => {
  it("md5s payload, key, timestamp, body and sigPath joined by newlines", () => {
    const expected = crypto
      .createHash("md5")
      .update(["PAYLOAD", "KEY", "1700000000", "BODY", "/api/v2/x"].join("\n"))
      .digest("hex");
    expect(computeCosySignature("PAYLOAD", "KEY", "1700000000", "BODY", "/api/v2/x")).toBe(expected);
  });

  it("treats a null body as the empty string", () => {
    expect(computeCosySignature("P", "K", "1", null, "/p")).toBe(computeCosySignature("P", "K", "1", "", "/p"));
  });

  it("hashes a Buffer body by its bytes, not by its string form", () => {
    const bytes = Buffer.from([0xf0, 0x9f, 0x9a, 0x80]);
    expect(computeCosySignature("P", "K", "1", bytes, "/p")).toBe(computeCosySignature("P", "K", "1", "🚀", "/p"));
  });
});

/**
 * 台账差异第 50 行：`info` 与 `Cosy-Key` 是**每凭据**算一次，不是每请求算一次。
 * 官方只在登录与 token 刷新时重算（`pretty.mjs:114927-114931`），此后每个请求回放同一对。
 */
describe("runtime auth field lifecycle", () => {
  const creds = { userID: "u-1", authToken: "jt-1", name: "Ada", email: "ada@x.com", machineID: "m-1" };
  const url = "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1";

  beforeEach(() => {
    resetRuntimeAuthCache();
  });

  it("replays the same Cosy-Key across requests made with one credential", () => {
    const first = buildAuthHeaders(null, url, creds);
    const second = buildAuthHeaders("some body", url, creds);
    expect(second["Cosy-Key"]).toBe(first["Cosy-Key"]);
    // info 藏在被签名的载荷里，所以它也必须是同一份。
    const infoOf = (h: Record<string, string>) =>
      JSON.parse(Buffer.from(h.Authorization.split(".")[1], "base64").toString("utf8")).info;
    expect(infoOf(second)).toBe(infoOf(first));
  });

  it("recomputes the pair when the token changes, which is what login and refresh do", () => {
    const first = buildAuthHeaders(null, url, creds);
    const afterRefresh = buildAuthHeaders(null, url, { ...creds, authToken: "jt-2" });
    expect(afterRefresh["Cosy-Key"]).not.toBe(first["Cosy-Key"]);
  });

  it("still varies the per-request fields", () => {
    // 每凭据缓存只覆盖 info / Cosy-Key；requestId 仍然每请求一个。
    const first = buildAuthHeaders(null, url, creds);
    const second = buildAuthHeaders(null, url, creds);
    const requestIdOf = (h: Record<string, string>) =>
      JSON.parse(Buffer.from(h.Authorization.split(".")[1], "base64").toString("utf8")).requestId;
    expect(requestIdOf(second)).not.toBe(requestIdOf(first));
  });
});
