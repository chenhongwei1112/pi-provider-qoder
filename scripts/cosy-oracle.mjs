/**
 * 官方 COSY 行为的预言机。加载 qodercli 自带的 WASM，对给定输入产出权威的
 * URL、请求头和编码后 body。审计里凡涉及这四项的结论都必须以它为准。
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const AUDIT_DIR = ".qoder-audit";

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

export async function createOracle({ auditDir, machineId, uid, encryptUserInfo, key, cosyVersion }) {
  const glue = await import(`file://${resolve(auditDir, "glue.mjs")}`);
  glue.initEnvModule();
  glue.initWasmModule();
  await glue.initWasm();

  // WASM 侧的 userInfoJson 就是登录响应里存下来的三段值，客户端只做回放。
  glue.createContext(machineId, cosyVersion, JSON.stringify({ uid, encrypt_user_info: encryptUserInfo, key }));

  return {
    clientMetadata: () => glue.getClientMetadata(),

    authRequest({ endpoint, path, method, body }) {
      return glue.prepareWasmAuthenticatedRequest({ endpoint, path, method, body });
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
