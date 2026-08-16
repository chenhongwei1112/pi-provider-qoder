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

  // 官方登录路径里 encrypt_user_info / key 全都是本地算的（台账差异第 14 行），
  // 入参形状取自 regenerateRuntimeFields()（pretty.mjs:114929）。
  const userInfo = {
    uid: "test-user-id",
    organization_id: "org-1",
    organization_tags: ["tag-a"],
    data_policy_agreed: true,
  };

  it("derives encrypt_user_info and key locally from the user info object", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const fields = oracle.runtimeAuthFields(userInfo);
    expect(Object.keys(fields).sort()).toEqual(["encrypt_user_info", "key"]);
    expect(typeof fields.encrypt_user_info).toBe("string");
    expect(typeof fields.key).toBe("string");
    expect(fields.encrypt_user_info.length).toBeGreaterThan(0);
    expect(fields.key.length).toBeGreaterThan(0);
  });

  // 台账差异第 50 行的服务端可观测性论证就靠这条：同一输入两次调用产出不同密文，
  // 所以「官方每条凭据算一次、插件每请求算一次」在服务端看得出来。
  it("produces a different pair on every call for the same input", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const first = oracle.runtimeAuthFields(userInfo);
    const second = oracle.runtimeAuthFields(userInfo);
    expect(second.encrypt_user_info).not.toBe(first.encrypt_user_info);
    expect(second.key).not.toBe(first.key);
  });

  // 台账差异第 40 行的两个前提，直接钉在官方 WASM 上。插件侧的对应物是
  // `qoderDecodeBody`，它与这里的输出的一致性由冻结向量那套用例覆盖。
  it("decrypts a response body back to the plaintext it encoded", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    const plain = JSON.stringify({ hello: "world", n: 42 });
    const encoded = oracle.inferRequest({
      endpoint: "https://api3.qoder.sh",
      body: plain,
      modelKey: "qmodel",
      modelSource: "system",
    }).body;
    expect(encoded).not.toBe(plain);
    expect(oracle.decryptServerResponse(encoded)).toBe(plain);
  });

  it("leaves an already-plaintext response body untouched", async () => {
    const oracle = await createOracle({ auditDir, ...identity });
    // 官方之所以能对每个非流式响应无条件调用它，就是因为这一条。
    for (const plain of ['{"a":1}', "{}", "", "not json at all"]) {
      expect(oracle.decryptServerResponse(plain)).toBe(plain);
    }
  });
});
