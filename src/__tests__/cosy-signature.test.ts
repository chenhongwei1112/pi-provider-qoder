import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeCosySignature, computeSigPath } from "../cosy.js";

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
