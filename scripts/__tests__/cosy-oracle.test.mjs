import { describe, expect, it } from "vitest";
import { createOracle, findAuditDir } from "../cosy-oracle.mjs";

const auditDir = findAuditDir();

// 产物由 `npm run audit:extract` 生成，需要本地安装 qodercli。
describe.skipIf(!auditDir)("cosy oracle against the official wasm", () => {
  const identity = {
    machineId: "0123456789abcdef0123456789abcdef",
    uid: "test-user-id",
    encryptUserInfo: "EUI",
    key: "KEY123",
    cosyVersion: "1.1.23",
  };

  it("reports the official client identity", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    expect(oracle.clientMetadata()).toEqual({
      client_type: "5",
      business_product: "cli",
      business_type: "agent",
      scene: "assistant",
    });
  });

  it("adds the /algo prefix and keeps Encode=1 on the model catalog request", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    expect(req.url).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
  });

  it("signs with md5 over payload, key, date, body and the /algo-stripped path", async () => {
    const { createHash } = await import("node:crypto");
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    const [payloadB64, signature] = req.headers.Authorization.replace("Bearer COSY.", "").split(".");
    const expected = createHash("md5")
      .update([payloadB64, req.headers["Cosy-Key"], req.headers["Cosy-Date"], "", "/api/v2/model/list"].join("\n"))
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("replays the credential-supplied user info and key verbatim", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.authRequest({
      endpoint: "https://api3.qoder.sh",
      path: "/api/v2/model/list?Encode=1",
      method: "GET",
    });
    const payload = JSON.parse(Buffer.from(req.headers.Authorization.split(".")[1], "base64").toString());
    expect(payload.info).toBe("EUI");
    expect(payload.version).toBe("v1");
    expect(payload.cosyVersion).toBe("1.1.23");
    expect(payload.ideVersion).toBe("");
    expect(req.headers["Cosy-Key"]).toBe("KEY123");
  });

  it("emits the business identity headers on the infer request", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const req = oracle.inferRequest({
      endpoint: "https://api3.qoder.sh",
      body: JSON.stringify({ session_id: "s-1" }),
      modelKey: "qmodel",
      modelSource: "system",
    });
    expect(req.url).toBe(
      "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation" +
        "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    );
    expect(req.headers["Cosy-Business-Product"]).toBe("cli");
    expect(req.headers["Cosy-Business-Type"]).toBe("agent");
    expect(req.headers["Cosy-Scene"]).toBe("assistant");
    expect(req.headers["X-Model-Key"]).toBe("qmodel");
    expect(req.headers["X-Model-Source"]).toBe("system");
    expect(req.headers.Connection).toBe("keep-alive");
    // infer 请求不带这两个——它们只出现在 auth 类请求上。
    expect(req.headers["Accept-Encoding"]).toBeUndefined();
    expect(req.headers["Cosy-ClientIp"]).toBeUndefined();
  });

  it("obfuscates the infer body inside the wasm", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const body = JSON.stringify({ session_id: "s-1", messages: [{ role: "user", content: "hi" }] });
    const req = oracle.inferRequest({ endpoint: "https://api3.qoder.sh", body, modelKey: "qmodel", modelSource: "system" });
    expect(req.body).not.toBe(body);
    expect(req.body.length).toBe(Math.ceil(Buffer.byteLength(body) / 3) * 4);
  });
});
