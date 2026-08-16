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
 * 已知差异清单。它现在是绿的，说明台账如实描述了当前状态;
 * 第二阶段每修掉一条头部差异，这里就会红一次 —— 那是提醒同步更新
 * docs/qoder-alignment-audit.md，不是让你放宽断言。
 */
describe("known header differences (locked, see docs/qoder-alignment-audit.md)", () => {
  const pluginHeaders = buildAuthHeaders(null, vectors.inferRequest.url, {
    userID: vectors.identity.uid,
    authToken: "token",
    name: "n",
    email: "e",
    machineID: vectors.identity.machineId,
  });
  // transport.ts:201-209 在 fetch 时并入的那几个头,预言机对比必须算进来。
  const transportHeaders = [
    "Content-Type",
    "Accept",
    "Cache-Control",
    "Accept-Encoding",
    "X-Model-Key",
    "X-Model-Source",
  ];
  const pluginNames = new Set([...Object.keys(pluginHeaders), ...transportHeaders]);
  const officialNames = new Set(vectors.inferRequest.headerNames);
  const lower = (s: Set<string>) => new Set([...s].map((n) => n.toLowerCase()));

  it("still misses exactly these official headers", () => {
    const missing = [...officialNames].filter((n) => !lower(pluginNames).has(n.toLowerCase())).sort();
    expect(missing).toEqual(["Connection", "Cosy-Business-Product", "Cosy-Business-Type", "Cosy-Scene"]);
  });

  it("still sends exactly these headers the official client does not", () => {
    const extra = [...pluginNames].filter((n) => !lower(officialNames).has(n.toLowerCase())).sort();
    expect(extra).toEqual([
      "Accept-Encoding",
      "Cosy-Bodyhash",
      "Cosy-Bodylength",
      "Cosy-Clientip",
      "Cosy-Organization-Id",
      "Cosy-Organization-Tags",
      "Cosy-Sigpath",
      "X-Request-Id",
    ]);
  });

  it("still spells these headers with different casing than the official client", () => {
    const mismatched = [...officialNames]
      .filter((official) => {
        const hit = [...pluginNames].find((p) => p.toLowerCase() === official.toLowerCase());
        return hit !== undefined && hit !== official;
      })
      .sort();
    expect(mismatched).toEqual([
      "Cosy-ClientType",
      "Cosy-MachineId",
      "Cosy-MachineOS",
      "Cosy-MachineToken",
      "Cosy-MachineType",
    ]);
  });

  it("still pins a stale Cosy-Version", () => {
    expect(pluginHeaders["Cosy-Version"]).toBe("1.1.3");
    expect(vectors.inferRequest.headers["Cosy-Version"]).toBe("1.1.23");
  });
});
