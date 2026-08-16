import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthHeaders,
  computeCosySignature,
  computeSigPath,
  getQoderChatURL,
  getQoderModelListURL,
} from "../cosy.js";
import { parseQoderJsonBody, qoderDecodeBody, qoderEncodeBody } from "../qoder-encoding.js";

interface OracleVectors {
  qodercliVersion: string;
  identity: { machineId: string; uid: string; encryptUserInfo: string; key: string; cosyVersion: string };
  clientMetadata: Record<string, string>;
  catalogRequest: { url: string; headerNames: string[]; headers: Record<string, string> };
  inferRequest: { url: string; headerNames: string[]; headers: Record<string, string> };
  signature: {
    payloadB64: string;
    payload: Record<string, string>;
    cosyKey: string;
    timestamp: string;
    body: string;
    sigPath: string;
    md5: string;
  };
  bodyEncoding: Array<{ input: string; encoded: string }>;
}

// 用 readFileSync 而不是 `import ... with { type: "json" }`：tsconfig.json 没开
// resolveJsonModule，JSON 模块导入过不了 `npm run check`，而改 tsconfig 只为
// 一个测试不值得。
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "cosy-oracle-vectors.json"), "utf8"),
) as OracleVectors;

describe("cosy signature against frozen official vectors", () => {
  it("reproduces the official md5 signature", () => {
    const { payloadB64, cosyKey, timestamp, body, sigPath, md5 } = vectors.signature;
    expect(computeCosySignature(payloadB64, cosyKey, timestamp, body, sigPath)).toBe(md5);
  });

  it("derives the same sigPath the official client signed", () => {
    expect(computeSigPath(vectors.catalogRequest.url)).toBe(vectors.signature.sigPath);
  });

  it("builds the same Authorization payload shape", () => {
    expect(Object.keys(vectors.signature.payload).sort()).toEqual([
      "cosyVersion",
      "ideVersion",
      "info",
      "requestId",
      "version",
    ]);
    expect(vectors.signature.payload.version).toBe("v1");
    expect(vectors.signature.payload.ideVersion).toBe("");
  });
});

describe("body obfuscation against frozen official vectors", () => {
  it.each(
    vectors.bodyEncoding.map((c, i) => [i, c] as const),
  )("matches the wasm output byte for byte (case %i)", (_i, c) => {
    expect(qoderEncodeBody(c.input)).toBe(c.encoded);
  });
});

/**
 * 解码方向。冻结向量里的 `encoded` 是官方 WASM 的真实输出，所以这一节等价于
 * 「插件的解码器 == 官方 decrypt_server_response」，而且不需要本地装 qodercli。
 * 官方对所有非流式 JSON 响应都过那一道，见 docs/qoder-alignment-audit.md 差异第 40 行。
 */
describe("body de-obfuscation against frozen official vectors", () => {
  it.each(vectors.bodyEncoding.map((c, i) => [i, c] as const))("recovers the plaintext (case %i)", (_i, c) => {
    expect(qoderDecodeBody(c.encoded)).toBe(c.input);
  });

  it("reads an encoded response body", () => {
    const c = vectors.bodyEncoding[0];
    expect(parseQoderJsonBody(c.encoded)).toEqual(JSON.parse(c.input));
  });

  it("passes a plaintext response body through untouched", () => {
    // 官方的 WASM 对明文恒等，这是它敢无条件调用的原因；插件这条路径必须同样无害。
    const c = vectors.bodyEncoding[0];
    expect(parseQoderJsonBody(c.input)).toEqual(JSON.parse(c.input));
  });
});

describe("URLs against frozen official vectors", () => {
  it("matches the official infer URL", () => {
    expect(getQoderChatURL("global")).toBe(vectors.inferRequest.url);
  });

  /**
   * 这条是为防 `8c50899` 那类回归而存在的：那次提交按"读反编译代码"的推断删掉了
   * `/algo` 与 `Encode=1`，而 cosy.test.ts 里写死正确值的两条用例被留在红灯状态。
   * 用冻结的官方值来断言，就没有"改源码顺手改断言"的空间了。
   */
  it("matches the official model catalog URL", () => {
    expect(getQoderModelListURL("global")).toBe(vectors.catalogRequest.url);
  });
});

/**
 * 剩余头部差异清单。它现在是绿的，说明台账如实描述了当前状态；
 * 每修掉一条头部差异，这里就会红一次 —— 那是提醒同步更新
 * docs/qoder-alignment-audit.md，不是让你放宽断言。
 *
 * **两个请求类都比。**官方 auth 类与 infer 类的头集不同（只有 auth 发
 * `Cosy-ClientIp` 与 `Accept-Encoding`，只有 infer 发 `Cache-Control` /
 * `Connection` / `X-Model-*`），所以只比 infer 会漏掉一半差异 —— 台账差异第 12 行
 * （auth GET 缺 `Content-Type`）当初就是这么漏出去的。
 */
const identityForHeaders = {
  userID: vectors.identity.uid,
  authToken: "token",
  name: "n",
  email: "e",
  machineID: vectors.identity.machineId,
};

/** fetch 调用点在请求头里并入的那几个，比对时必须算进来。 */
const transportMergedHeaders = {
  // transport.ts:199-213
  infer: ["Content-Type", "Accept", "Cache-Control", "Connection", "X-Model-Key", "X-Model-Source"],
  // models.ts:161-170
  auth: ["Content-Type", "Accept"],
};

const lower = (s: Set<string>) => new Set([...s].map((n) => n.toLowerCase()));

function headerDiff(requestClass: "auth" | "infer") {
  const frozen = requestClass === "auth" ? vectors.catalogRequest : vectors.inferRequest;
  const pluginHeaders = buildAuthHeaders(null, frozen.url, identityForHeaders, requestClass);
  const pluginNames = new Set([...Object.keys(pluginHeaders), ...transportMergedHeaders[requestClass]]);
  const officialNames = new Set(frozen.headerNames);
  return {
    pluginHeaders,
    missing: [...officialNames].filter((n) => !lower(pluginNames).has(n.toLowerCase())).sort(),
    extra: [...pluginNames].filter((n) => !lower(officialNames).has(n.toLowerCase())).sort(),
    mismatched: [...officialNames]
      .filter((official) => {
        const hit = [...pluginNames].find((p) => p.toLowerCase() === official.toLowerCase());
        return hit !== undefined && hit !== official;
      })
      .sort(),
  };
}

describe("known header differences (locked, see docs/qoder-alignment-audit.md)", () => {
  it("sends every official header on the infer request", () => {
    // `Cosy-MachineHostname` 是官方发、插件也发的，但值随机器变化，故不冻结进向量
    // （台账差异第 13 行），所以它在这里既不算缺失也不算多发。
    expect(headerDiff("infer").missing).toEqual([]);
  });

  it("sends nothing extra on the infer request", () => {
    expect(headerDiff("infer").extra).toEqual(["Cosy-MachineHostname"]);
  });

  it("sends every official header on the auth request", () => {
    expect(headerDiff("auth").missing).toEqual([]);
  });

  it("sends nothing extra on the auth request", () => {
    expect(headerDiff("auth").extra).toEqual([]);
  });

  it("spells every shared header exactly as the official client does, on both request classes", () => {
    expect(headerDiff("infer").mismatched).toEqual([]);
    expect(headerDiff("auth").mismatched).toEqual([]);
  });

  it("keeps Cosy-ClientIp and Accept-Encoding on the auth class only", () => {
    // 官方的 `Cosy-ClientIp` 值是 machineId，不是真 IP —— 插件此前恒发 127.0.0.1。
    const auth = headerDiff("auth").pluginHeaders;
    expect(auth["Cosy-ClientIp"]).toBe(vectors.catalogRequest.headers["Cosy-ClientIp"]);
    expect(auth["Accept-Encoding"]).toBe(vectors.catalogRequest.headers["Accept-Encoding"]);
    const infer = headerDiff("infer").pluginHeaders;
    expect(infer["Cosy-ClientIp"]).toBeUndefined();
    expect(infer["Accept-Encoding"]).toBeUndefined();
  });

  it("sends the same Cosy-Version as the official client, in the header and in the signed payload", () => {
    // 这个常量喂两处，所以两处都要对上：请求头，以及被签名的 Authorization 载荷。
    const { pluginHeaders } = headerDiff("infer");
    expect(pluginHeaders["Cosy-Version"]).toBe(vectors.inferRequest.headers["Cosy-Version"]);
    const payload = JSON.parse(Buffer.from(pluginHeaders.Authorization.split(".")[1], "base64").toString("utf8"));
    expect(payload.cosyVersion).toBe(vectors.signature.payload.cosyVersion);
  });
});
