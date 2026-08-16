/**
 * 把预言机的输出冻结成测试向量。需要本地安装 qodercli 并先跑过
 * `npm run audit:extract`。产物提交进仓库，使回归测试不依赖官方安装。
 */
import { writeFileSync } from "node:fs";
import { createOracle, findAuditDir } from "./cosy-oracle.mjs";

const IDENTITY = {
  machineId: "0123456789abcdef0123456789abcdef",
  uid: "test-user-id",
  encryptUserInfo: "EUI",
  key: "KEY123",
  cosyVersion: "1.1.23",
};

const BODY_CASES = [
  JSON.stringify({ session_id: "s-1", messages: [{ role: "user", content: "hi" }] }),
  JSON.stringify({ a: "x".repeat(1000) }),
  "{}",
  JSON.stringify({ u: "中文测试 emoji 🚀" }),
];

/**
 * WASM 只产出一部分请求头，官方在 JS 层还会补身份头。取证（`.qoder-audit/1.1.23/pretty.mjs`）：
 *   :69460  `EUH(C2,"Cosy-Version",CUH), EUH(C2,"Cosy-ClientType",SM().client_type),
 *            EUH(C2,"Cosy-MachineOS",QUH)`，并在 `requestClass === "infer-sse"` 时追加
 *            `Cosy-MachineHostname`
 *   :69431  `EUH` 是大小写无关的「不存在才写」，所以 WASM 已给的 `Cosy-Version` /
 *            `Cosy-ClientType` 不会被覆盖 —— 实际只多出 `Cosy-MachineOS` 一个
 *   :69487  `var QUH = "x86_64_linux"`
 *   :105910 model-list 与 :146170 infer-sse 都传 `injectClientIdentityHeaders:
 *            !isServiceAccount()`，普通用户为 true，两类请求都注入
 * `Cosy-MachineHostname` 取值随机器变化（:69407 主机名不 header-safe 时会被规范化甚至省略），
 * 冻结进向量会让测试在别的机器上红，所以不冻结，只在 Task 8 台账里记成条件差异。
 */
const JS_LAYER_HEADERS = { "Cosy-MachineOS": "x86_64_linux" };

function withJsLayerHeaders(headers) {
  const out = { ...headers };
  for (const [name, value] of Object.entries(JS_LAYER_HEADERS)) {
    if (!Object.keys(out).some((n) => n.toLowerCase() === name.toLowerCase())) out[name] = value;
  }
  return out;
}

const auditDir = findAuditDir();
if (!auditDir) throw new Error("freeze: no .qoder-audit/<version>/glue.mjs; run npm run audit:extract first");

const oracle = await createOracle({ auditDir, ...IDENTITY });

// 目录请求是 GET、无请求体。这里显式命名，好让签名向量里的 body 与真正喂给
// 预言机的输入同源 —— 两处各写一遍的话，将来给 authRequest 加了 body 就会脱钩。
const CATALOG_BODY = null;

const catalog = oracle.authRequest({
  endpoint: "https://api3.qoder.sh",
  path: "/api/v2/model/list?Encode=1",
  method: "GET",
  body: CATALOG_BODY,
});
const [payloadB64, signature] = catalog.headers.Authorization.replace("Bearer COSY.", "").split(".");

const infer = oracle.inferRequest({
  endpoint: "https://api3.qoder.sh",
  body: BODY_CASES[0],
  modelKey: "qmodel",
  modelSource: "system",
});

const vectors = {
  qodercliVersion: auditDir.split("/").at(-1),
  identity: IDENTITY,
  clientMetadata: oracle.clientMetadata(),
  catalogRequest: {
    url: catalog.url,
    headerNames: Object.keys(withJsLayerHeaders(catalog.headers)).sort(),
    headers: omitVolatile(withJsLayerHeaders(catalog.headers)),
  },
  inferRequest: {
    url: infer.url,
    headerNames: Object.keys(withJsLayerHeaders(infer.headers)).sort(),
    headers: omitVolatile(withJsLayerHeaders(infer.headers)),
  },
  signature: {
    payloadB64,
    payload: JSON.parse(Buffer.from(payloadB64, "base64").toString()),
    cosyKey: catalog.headers["Cosy-Key"],
    timestamp: catalog.headers["Cosy-Date"],
    body: CATALOG_BODY ?? "",
    sigPath: "/api/v2/model/list",
    md5: signature,
  },
  bodyEncoding: BODY_CASES.map((input) => ({
    input,
    encoded: oracle.inferRequest({
      endpoint: "https://api3.qoder.sh",
      body: input,
      modelKey: "qmodel",
      modelSource: "system",
    }).body,
  })),
};

/** Authorization / Cosy-Date 每次都变，冻结它们只会让测试变脆。 */
function omitVolatile(headers) {
  const { Authorization, "Cosy-Date": _date, ...stable } = headers;
  return Object.fromEntries(Object.entries(stable).sort(([a], [b]) => a.localeCompare(b)));
}

writeFileSync("src/__tests__/fixtures/cosy-oracle-vectors.json", `${JSON.stringify(vectors, null, 2)}\n`);
console.log("froze vectors for qodercli", vectors.qodercliVersion);
