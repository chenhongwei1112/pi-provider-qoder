import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { domainToASCII } from "node:url";
import { agentPath } from "./paths.js";

const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

// COSY 客户端身份，与 qodercli 1.1.23 的实测值对齐（台账差异第 2、5 行）。
// 这些值同时进请求头与被签名的 Authorization 载荷，冻结值见
// `src/__tests__/fixtures/cosy-oracle-vectors.json`。
const QoderIDEVersion = "1.1.23";
const QoderClientType = "5";
const QoderLoginVersion = "v2";
// 官方 getClientMetadata() 的默认值（`pretty.mjs:400-404`）。官方另支持用
// QODER_BUSINESS_PRODUCT / QODER_BUSINESS_TYPE / QODER_SCENE 覆盖，插件不支持，
// 因为 omp 侧没有对应的配置入口 —— 需要时再加。
const QoderBusinessProduct = "cli";
const QoderBusinessType = "agent";
const QoderScene = "assistant";

/**
 * `User-Agent` for this provider's own auxiliary requests: device-code login,
 * PAT exchange, token refresh, and usage lookups. Qoder does not validate it —
 * the signed COSY headers carry the real client identity — so it exists to
 * identify us in server logs, not to impersonate the official client.
 */
export const ProviderUserAgent = "omp-provider-qoder";
const QoderMachineOS =
  process.platform === "win32"
    ? process.arch === "arm64"
      ? "aarch64_windows"
      : "x86_64_windows"
    : process.arch === "arm64"
      ? "aarch64_linux"
      : "x86_64_linux";
const QoderMachineTypeMagic = "5";

const QoderModeEnv = process.env.QODER_REGION || process.env.QODER_BACKEND || process.env.QODER_MODE || "";

export type QoderMode = "global" | "cn";

/**
 * `info` 的明文。官方喂给 `generate_runtime_auth_fields` 的正是这四个字段
 * （`pretty.mjs:114929`，台账差异第 14 行）—— 没有 token、没有 name、没有 email。
 * 早前插件塞的是 `{uid, security_oauth_token, name, aid, email}`。
 */
interface UserInfo {
  uid: string;
  organization_id: string;
  organization_tags: string[];
  data_policy_agreed: boolean;
}

interface CosyPayload {
  version: string;
  requestId: string;
  info: string;
  cosyVersion: string;
  ideVersion: string;
}
export interface CosyCredentials {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID?: string;
  /** 来自 `/api/v1/userinfo`。决定是否发 `Cosy-Organization-*`，也进 `info` 明文。 */
  organizationID?: string;
  organizationTags?: string[];
  /**
   * data policy 是否已同意。官方由 `fetchAndApplyDataPolicy` 拉取，插件不调那个接口，
   * 所以默认 false —— 这与插件一直硬编码的 `Cosy-Data-Policy: disagree` 等价（实测：
   * WASM 把 `data_policy_agreed` 投影成该头，false → disagree、true → agree）。
   */
  dataPolicyAgreed?: boolean;
}

export function getQoderMode(modeOverride?: string): QoderMode {
  const mode = (modeOverride || QoderModeEnv).toLowerCase();
  if (["cn", "china", "qodercn", "qoder-cn"].includes(mode)) return "cn";
  if (["global", "intl", "international", "qoder"].includes(mode)) return "global";
  if (
    (process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PAT) &&
    !(process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT)
  ) {
    return "cn";
  }
  return "global";
}

export function isQoderCNMode(modeOverride?: string): boolean {
  return getQoderMode(modeOverride) === "cn";
}

export function getQoderBaseUrl(mode?: string): string {
  return isQoderCNMode(mode) ? "https://gateway.qoder.com.cn/" : "https://api3.qoder.sh/";
}

export function getQoderOpenApiUrl(mode?: string): string {
  return isQoderCNMode(mode) ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
}

export function getQoderCenterUrl(mode?: string): string {
  return isQoderCNMode(mode) ? "https://gateway.qoder.com.cn" : "https://center.qoder.sh";
}

export function getQoderModelListURL(mode?: string): string {
  // 与 qodercli 1.1.23 对齐，由预言机实跑确认（台账差异第 1 行）：官方目录端点是
  // `/algo/api/v2/model/list?Encode=1`。此前这里去掉了 `/algo` 与 `Encode=1`，
  // 依据是读反编译代码得出的推断，而预言机直接推翻了它 —— 冻结值见
  // `src/__tests__/fixtures/cosy-oracle-vectors.json` 的 `catalogRequest.url`。
  return `${getQoderBaseUrl(mode)}algo/api/v2/model/list?Encode=1`;
}

export function getQoderChatURL(mode?: string): string {
  return `${getQoderBaseUrl(mode)}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function getQoderExchangeURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v1/jobToken/exchange`;
}

export function getQoderUserInfoURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v1/userinfo`;
}

export function getQoderUsageURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v2/quota/usage`;
}

export function getQoderRefreshURL(mode?: string): string {
  return `${getQoderCenterUrl(mode)}/algo/api/v3/user/refresh_token`;
}

export function getQoderCNDirectModel(modelID?: string): string {
  return (
    {
      "qoder-cn": "auto",
      "qwen3.7-max": "qmodel_latest",
      "qwen3.7-plus": "qmodel",
      "qwen3.6-plus": "qmodel",
      "qwen3.6-flash": "q36fmodel",
      "deepseek-v4-pro": "dmodel",
      "deepseek-v4-flash": "dfmodel",
      "glm-5.2": "gm51model",
      "glm-5.1": "gm51model",
      "kimi-k2.6": "kmodel",
      "minimax-m2.7": "mmodel",
      "minimax-m3": "mmodel",
    }[modelID || ""] ||
    modelID ||
    "auto"
  );
}

const qoderCNFriendlyModels: Record<string, { id: string; name: string }> = {
  auto: { id: "auto", name: "Auto · Qoder CN" },
  "qoder-cn": { id: "qoder-cn", name: "Auto · Qoder CN" },
  qmodel_latest: { id: "qwen3.7-max", name: "Qwen 3.7 Max · Qoder CN" },
  qmodel: { id: "qwen3.7-plus", name: "Qwen 3.7 Plus · Qoder CN" },
  q36fmodel: { id: "qwen3.6-flash", name: "Qwen 3.6 Flash · Qoder CN" },
  qfmodel: { id: "qwen3.6-flash", name: "Qwen 3.6 Flash · Qoder CN" },
  dmodel: { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro · Qoder CN" },
  dfmodel: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Qoder CN" },
  gm51model: { id: "glm-5.2", name: "GLM 5.2 · Qoder CN" },
  kmodel: { id: "kimi-k2.6", name: "Kimi K2.6 · Qoder CN" },
  mmodel: { id: "minimax-m2.7", name: "MiniMax M2.7 · Qoder CN" },
};

function prettifyQoderCNModelName(name: string): string {
  const pretty = (name || "Qoder CN Model")
    .replace(/Qwen(\d)/g, "Qwen $1")
    .replace(/Qwen([\d.]+)-/g, "Qwen $1 ")
    .replace(/DeepSeek\s*V(\d)-/g, "DeepSeek V$1 ")
    .replace(/\s+/g, " ")
    .trim();
  return pretty.includes("Qoder CN") ? pretty : `${pretty} · Qoder CN`;
}

export function getQoderCNFriendlyModelInfo(key: string, display?: string): { id: string; name: string } {
  return qoderCNFriendlyModels[key] || { id: key, name: prettifyQoderCNModelName(display || key) };
}

export function toQoderCNFriendlyModel<T extends { id: string; name: string }>(model: T): T {
  const info = getQoderCNFriendlyModelInfo(model.id, model.name);
  return {
    ...model,
    id: info.id,
    name: info.name,
  };
}

export function getQoderManageUrl(mode?: string): string {
  return isQoderCNMode(mode) ? "https://qoder.com.cn" : "https://qoder.com";
}

export function getQoderUserEmailFallback(mode?: string): string {
  return isQoderCNMode(mode) ? "user@qoder.com.cn" : "user@qoder.com";
}

/** The identity fields COSY signing needs from a credentials object. */
export interface QoderIdentity {
  userID: string;
  name: string;
  email: string;
  machineID: string;
}

/**
 * The placeholders used when the auth store has no answer.
 *
 * `machineID` is deliberately absent: it falls back to `getMachineId()`, which
 * touches the filesystem and may write a new id, so it is resolved by the
 * caller rather than bundled into a plain defaults record.
 */
export function qoderIdentityDefaults(mode: string): Omit<QoderIdentity, "machineID"> {
  return {
    userID: "qoder-user",
    name: isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User",
    email: getQoderUserEmailFallback(mode),
  };
}

function rsaEncryptBase64(data: Buffer | string): string {
  const key = {
    key: qoderRSAPublicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  };
  const encrypted = crypto.publicEncrypt(key, typeof data === "string" ? Buffer.from(data) : data);
  return encrypted.toString("base64");
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

export function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) {
    sigPath = sigPath.substring("/algo".length);
  }
  return sigPath;
}

/**
 * COSY 签名：md5(payloadB64 \n cosyKey \n timestamp \n body \n sigPath)。
 * 已用官方 WASM 逐字节验证（见 scripts/cosy-oracle.mjs）。
 *
 * 分段喂给 md5 而不是拼成一个字符串：body 是编码后的请求体，长对话下可达
 * 几百 KB，模板字符串会把它多拷两遍。
 */
export function computeCosySignature(
  payloadB64: string,
  cosyKey: string,
  timestamp: string,
  body: Buffer | string | null,
  sigPath: string,
): string {
  return crypto
    .createHash("md5")
    .update(payloadB64)
    .update("\n")
    .update(cosyKey)
    .update("\n")
    .update(timestamp)
    .update("\n")
    .update(body ?? "")
    .update("\n")
    .update(sigPath)
    .digest("hex");
}

export function getMachineId(): string {
  // The Qoder IDE's own machine id comes first: reusing it is what keeps this
  // client on the same device fingerprint as the official one. Our own copy in
  // omp's agent directory is the fallback for machines without the IDE.
  const paths = [join(homedir(), ".qoder", ".auth", "machine_id"), agentPath("qoder-machine-id")];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const val = readFileSync(p, "utf8").trim();
        if (val) return val;
      } catch {}
    }
  }
  // No stored id anywhere. Prefer the official hardware-derived value
  // (`pretty.mjs:76181-76209`) over a random one: a machine that runs both this
  // plugin and the official client then reports ONE device fingerprint instead
  // of two (ledger row 51). On this class of host the DMI uuid is root-only,
  // so derivation returns undefined here and the random fallback applies.
  const newId = deriveMachineIdFromHardware() ?? crypto.randomUUID();
  try {
    const savePath = paths[1];
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, newId, "utf8");
  } catch {}
  return newId;
}

/** Official machine-id salt (`pretty.mjs:76498`). */
const MachineIdSalt = "qoder-machine-id:v1";

/**
 * Derive the machine id from the DMI product uuid exactly as the official
 * client does (`pretty.mjs:76181-76209`): sha256 over
 * `<salt>:linux:<uuid lowercased>`, take the first 16 bytes, set the UUID v4
 * variant/version bits, format as 8-4-4-4-12 (`Muf`/`Cuf`,
 * `pretty.mjs:76167-76173`). Returns undefined when the uuid is unreadable or
 * a placeholder — the official validator (`Uuf`, `pretty.mjs:76175-76179`)
 * rejects empty / all-zero / all-`f` / OEM filler values.
 *
 * The official read runs under a 1s timeout with an async system call. This
 * version is sync and only used as a fallback when no stored id exists, so the
 * common path (a stored id) never touches the filesystem for this at all.
 */
export function deriveMachineIdFromHardware(): string | undefined {
  let uuid: string;
  try {
    uuid = readFileSync("/sys/class/dmi/id/product_uuid", "utf8").trim().toLowerCase();
  } catch {
    return undefined;
  }
  if (!uuid || uuid === "-" || uuid === "unknown" || uuid === "none") return undefined;
  const alnum = uuid.replace(/[^a-z0-9]/g, "");
  if (alnum.length === 0 || /^0+$/.test(alnum) || /^f+$/.test(alnum)) return undefined;
  const digest = crypto.createHash("sha256").update(`${MachineIdSalt}:linux:${uuid}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * `info` 与 `Cosy-Key` 的生命周期：**每凭据一次**，不是每请求一次（台账差异第 50 行）。
 *
 * 官方只在登录与 token 刷新时调 `regenerateRuntimeFields()`
 * （`pretty.mjs:114927-114931`），算出的一对灌进 QoderContext，此后每个请求原样回放。
 * 插件此前每个请求都现摇一个随机 AES key，于是每个请求的 `Cosy-Key` 都不同 —— 这在
 * 服务端是能看出来的：预言机实测官方的 `generate_runtime_auth_fields` 同输入两次调用
 * 密文也不同（`scripts/__tests__/cosy-oracle.test.mjs` 的
 * "produces a different pair on every call for the same input"），所以"每请求都换一对"
 * 只可能是重算，不可能是回放。
 *
 * 按凭据缓存即等价于官方的时机：key 里带上 authToken，token 一换（登录或刷新）就自然
 * 重算。缓存只保留最后一条，因为同一进程里同时活跃多个 Qoder 凭据不是现实场景。
 */
let runtimeAuthCache: { key: string; infoB64: string; cosyKey: string } | undefined;

function runtimeAuthFields(creds: CosyCredentials): { infoB64: string; cosyKey: string } {
  const organizationID = creds.organizationID || "";
  const organizationTags = creds.organizationTags ?? [];
  const dataPolicyAgreed = creds.dataPolicyAgreed ?? false;
  const cacheKey = [creds.userID, creds.authToken, organizationID, organizationTags.join(","), dataPolicyAgreed].join(
    "\n",
  );
  if (runtimeAuthCache?.key === cacheKey) {
    return { infoB64: runtimeAuthCache.infoB64, cosyKey: runtimeAuthCache.cosyKey };
  }

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo: UserInfo = {
    uid: creds.userID,
    organization_id: organizationID,
    organization_tags: organizationTags,
    data_policy_agreed: dataPolicyAgreed,
  };

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);
  runtimeAuthCache = { key: cacheKey, infoB64, cosyKey };
  return { infoB64, cosyKey };
}

/** 测试用：清掉每凭据缓存，让下一次调用重新算一对。 */
export function resetRuntimeAuthCache(): void {
  runtimeAuthCache = undefined;
}

/**
 * `Cosy-MachineHostname` 的取值，照官方 `pretty.mjs:69383-69398` 实现。
 *
 * 官方不直接发 `os.hostname()`：主机名可能含非 ASCII 或空格，塞进 HTTP 头会坏。
 * 规则是——本来就 header-safe 就原样发；能 punycode 成 ASCII 就发那个；否则把不安全
 * 的连续字符压成 `-`，再缀上原值 sha256 的前 8 位；最后统一限长 96 字符，超了就截断
 * 并同样缀 8 位哈希。全流程无网络、无随机，同一台机器恒定。
 */
const HostnameHeaderSafe = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;
const HostnameUnsafeRun = /[^\x21-\x7e]+/gu;
const HostnameMaxLength = 96;
const HostnameHashLength = 8;

function hostnameHash(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, HostnameHashLength);
}

function truncateHostname(value: string): string {
  if (value.length <= HostnameMaxLength) return value;
  const head = value.slice(0, HostnameMaxLength - HostnameHashLength - 1).replace(/[-\s]+$/u, "");
  const hash = hostnameHash(value);
  return head ? `${head}-${hash}` : `unknown-${hash}`;
}

/** 导出仅为可测：这是官方规范化的逐步复刻，值得单独钉住。 */
export function normalizeMachineHostname(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (HostnameHeaderSafe.test(trimmed)) return truncateHostname(trimmed);

  const ascii = domainToASCII(trimmed);
  if (ascii && HostnameHeaderSafe.test(ascii)) return truncateHostname(ascii);

  const hash = hostnameHash(trimmed);
  const slug = trimmed
    .replace(HostnameUnsafeRun, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return truncateHostname(slug ? `${slug}-${hash}` : `unknown-${hash}`);
}

function machineHostnameHeaderValue(): string {
  return normalizeMachineHostname(hostname());
}

/**
 * 官方按请求类发不同的头（台账差异第 6、10、11、12、13 行，实测见冻结向量
 * `catalogRequest` 与 `inferRequest` 两组 `headerNames`）：
 * - 只在 auth 类：`Cosy-ClientIp`（值是 machineId，不是真 IP）、`Accept-Encoding: identity`
 * - 只在 infer 类：`Cache-Control`、`Connection`、`X-Model-Key`、`X-Model-Source`、
 *   以及 header-safe 时的 `Cosy-MachineHostname`
 */
export type CosyRequestClass = "auth" | "infer";

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
  requestClass: CosyRequestClass = "infer",
): Record<string, string> {
  if (!creds.userID) {
    throw new Error("cosy: user id is empty");
  }
  if (!creds.authToken) {
    throw new Error("cosy: auth token is empty");
  }

  const { infoB64, cosyKey } = runtimeAuthFields(creds);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();

  const cosyPayload: CosyPayload = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: QoderIDEVersion,
    ideVersion: "",
  };

  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
  const sigPath = computeSigPath(requestURL);

  const sig = computeCosySignature(payloadB64, cosyKey, timestamp, body, sigPath);

  const machineID = creds.machineID || getMachineId();

  // 头名大小写与官方逐字符一致（第 3、4 行）。不发 `Cosy-Bodyhash` /
  // `Cosy-Bodylength` / `Cosy-Sigpath`（第 7 行）：把签名的中间量摊在明文头里是最
  // 显眼的非官方特征。也不发 `Cosy-Organization-Id` / `-Tags`（第 8 行，官方在本
  // 审计的取证身份下不发）与 `X-Request-Id`（第 9 行，官方只在 openapi 类请求上发
  // 且拼作 `X-Request-ID`）。
  const headers: Record<string, string> = {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": QoderIDEVersion,
    "Cosy-MachineId": machineID,
    "Cosy-MachineToken": machineID,
    "Cosy-MachineType": QoderMachineTypeMagic,
    "Cosy-MachineOS": QoderMachineOS,
    "Cosy-ClientType": QoderClientType,
    "Cosy-Business-Product": QoderBusinessProduct,
    "Cosy-Business-Type": QoderBusinessType,
    "Cosy-Scene": QoderScene,
    "Cosy-Data-Policy": creds.dataPolicyAgreed ? "agree" : "disagree",
    "Login-Version": QoderLoginVersion,
  };

  // 组织头按需发（台账差异第 8 行修正）。实测：WASM 只在 user-info 带
  // `organization_id` / `organization_tags` 时才产出这两个头，tags 用 `,` 连接；
  // 没有组织就完全不发。插件此前恒发两个空串，那是两头都不像。
  if (creds.organizationID) headers["Cosy-Organization-Id"] = creds.organizationID;
  if (creds.organizationTags?.length) headers["Cosy-Organization-Tags"] = creds.organizationTags.join(",");

  if (requestClass === "auth") {
    // 官方在 auth 类上把 machineId 当 `Cosy-ClientIp` 发（第 10 行），并要求
    // `identity` 编码（第 11 行）。插件此前恒发 `127.0.0.1` 且两类都发。
    headers["Cosy-ClientIp"] = machineID;
    headers["Accept-Encoding"] = "identity";
  } else {
    // 只有 infer-sse 带主机名，且必须是 header-safe 的（第 13 行）。
    const hostname = machineHostnameHeaderValue();
    if (hostname) headers["Cosy-MachineHostname"] = hostname;
  }

  return headers;
}
