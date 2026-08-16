/**
 * 官方 COSY 行为的预言机。加载 qodercli 自带的 WASM，对给定输入产出权威的
 * URL、请求头和编码后 body。审计里凡涉及这四项的结论都必须以它为准。
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const AUDIT_DIR = ".qoder-audit";

export function findAuditDir() {
  if (!existsSync(AUDIT_DIR)) return null;
  const versions = readdirSync(AUDIT_DIR).filter((v) => existsSync(resolve(AUDIT_DIR, v, "glue.mjs")));
  if (versions.length === 0) return null;
  versions.sort((a, b) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  return resolve(AUDIT_DIR, versions.at(-1));
}

export async function createOracle({
  auditDir,
  machineId,
  uid,
  encryptUserInfo,
  key,
  cosyVersion,
  organizationId,
  organizationTags,
  dataPolicyAgreed,
}) {
  const glue = await import(`file://${resolve(auditDir, "glue.mjs")}`);
  glue.initEnvModule();
  // `initWasmModule()` 实测是冗余的（去掉它 `initWasm()` 依然能跑通），但保留是故意的：
  // 不去依赖 carved glue 里「访问导出会顺带触发模块初始化」这个未声明的内部行为。
  // 官方换个构建方式就可能变，显式按序初始化的代价是一行。
  glue.initWasmModule();
  await glue.initWasm();

  // 官方交给 QoderContext 的 user-info 是六个字段（`pretty.mjs:114847`），不是三个。
  // 组织字段与 data policy 会直接影响 WASM 产出的请求头，实测：
  //   - 带 organization_id / organization_tags 时才有 `Cosy-Organization-Id` /
  //     `-Tags`（tags 用 `,` 连接）；不带就完全不发这两个头
  //   - `Cosy-Data-Policy` 是 data_policy_agreed 的投影：false → disagree、true → agree
  // 早期只喂三段，所以台账第 8 行一度误判成"官方不发组织头"。
  //
  // `encrypt_user_info` 与 `key` 由调用方给定、WASM 原样回放（这是预言机能做对照的
  // 前提）。注意官方客户端里这两个值**不是**服务端下发的：每条登录路径都先置空
  // （`:114651` PAT / `:114720` job_token / `:114939` browser / `:115056` external），
  // 再由 `regenerateRuntimeFields()` 本地经 `generate_runtime_auth_fields` 算出
  // （`:114927-114931`）。详见台账差异第 14 行。
  const userInfo = { uid, encrypt_user_info: encryptUserInfo, key };
  if (organizationId !== undefined) userInfo.organization_id = organizationId;
  if (organizationTags !== undefined) userInfo.organization_tags = organizationTags;
  if (dataPolicyAgreed !== undefined) userInfo.data_policy_agreed = dataPolicyAgreed;
  glue.createContext(machineId, cosyVersion, JSON.stringify(userInfo));

  return {
    clientMetadata: () => glue.getClientMetadata(),

    authRequest({ endpoint, path, method, body }) {
      return glue.prepareWasmAuthenticatedRequest({ endpoint, path, method, body });
    },

    // 官方 regenerateRuntimeFields()（pretty.mjs:114927-114931）的调用形状：单个 JSON
    // 字符串进、JSON 字符串出，调用方 parse 成 { encrypt_user_info, key }。入参对象是
    // { uid, organization_id, organization_tags, data_policy_agreed }。
    runtimeAuthFields(userInfo) {
      return JSON.parse(glue.generate_runtime_auth_fields(JSON.stringify(userInfo)));
    },

    // 官方对所有非流式 JSON 响应体都过这一道（台账差异第 40 行）。它对明文恒等，
    // 所以官方敢无条件调；插件侧的对应物是 `qoderDecodeBody`。
    decryptServerResponse(text) {
      return String(glue.decryptServerResponse(text));
    },

    inferRequest({ endpoint, body, modelKey, modelSource }) {
      const result = glue.withWasmContextRetry((ctx) => ctx.prepareInferRequest(endpoint, body, modelKey, modelSource));
      try {
        return { url: result.url, headers: glue.headersMapToRecord(result.headers), body: String(result.body) };
      } finally {
        result.free();
      }
    },
  };
}
