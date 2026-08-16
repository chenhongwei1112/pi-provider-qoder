import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
  getMachineId,
  getQoderExchangeURL,
  getQoderMode,
  getQoderUserInfoURL,
  ProviderUserAgent,
  qoderIdentityDefaults,
} from "./cosy.js";

/**
 * Marker prefix used in the credential `refresh` field to identify PAT-based
 * credentials. Layout: `pat|<personalToken>|<jobRefreshToken>|<userID>|<machineID>`
 */
export const PAT_REFRESH_PREFIX = "pat";

export interface PatExchangeResult {
  /** Short-lived job token (jt-...) used for auth + COSY signatures. */
  jobToken: string;
  /** Job refresh token (jrt-...), if returned. */
  jobRefreshToken: string;
  expiresAt: number;
}

export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_REFRESH_PREFIX}|`);
}

/** Encode a PAT credential's refresh field. */
export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

/** Decode a PAT credential's refresh field. */
export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

/**
 * Exchange a Qoder Personal Access Token (pt-...) for a short-lived Job Token
 * (jt-...). PATs cannot authenticate API calls directly; they must first be
 * exchanged. This mirrors the official qodercli/qoderclicn flow:
 *   POST /api/v1/jobToken/exchange { personal_token } -> { token, refresh_token, expires_at }
 * The exchange endpoint does not require a COSY signature.
 */
export async function exchangeJobToken(pat: string, mode: string = getQoderMode()): Promise<PatExchangeResult> {
  const res = await fetch(getQoderExchangeURL(mode), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": ProviderUserAgent,
      "Cosy-Version": "1.0.1",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ personal_token: pat }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };

  if (!data.token) {
    throw new Error("Qoder PAT exchange returned no job token");
  }

  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (data.expires_in) {
    // expires_in is in milliseconds per the observed API response.
    expiresAt = Date.now() + data.expires_in;
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt,
  };
}

/**
 * 用 job token 取用户资料。best-effort。
 *
 * 读的字段跟着官方走（`pretty.mjs:114999-115002`）：uid 与 name 各有三个别名，
 * 组织信息还有驼峰与嵌套两种写法。组织字段不是可选装饰 —— 它们决定 WASM 是否发
 * `Cosy-Organization-Id` / `-Tags`，也是 `info` 明文的组成部分（台账差异第 8、14、49 行）。
 */
async function fetchUserInfo(
  jobToken: string,
  mode: string,
): Promise<{
  userID: string;
  email: string;
  name: string;
  organizationID: string;
  organizationTags: string[];
}> {
  let userID = "";
  let email = "";
  let name = "";
  let organizationID = "";
  let organizationTags: string[] = [];
  try {
    const res = await fetch(getQoderUserInfoURL(mode), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": ProviderUserAgent,
      },
    });
    if (res.ok) {
      const info = (await res.json()) as {
        id?: string;
        user_id?: string;
        uid?: string;
        email?: string;
        name?: string;
        username?: string;
        user_name?: string;
        orgId?: string;
        organization_id?: string;
        organizationId?: string;
        organization?: { id?: string };
        organization_tags?: unknown;
        organizationTags?: unknown;
      };
      userID = info.id || info.user_id || info.uid || "";
      email = info.email || "";
      name = info.name || info.username || info.user_name || "";
      organizationID = info.orgId || info.organization_id || info.organizationId || info.organization?.id || "";
      const tags = info.organization_tags ?? info.organizationTags;
      organizationTags = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
    }
  } catch (e) {
    console.error("[pi-provider-qoder] Failed to fetch user info:", e);
  }
  return { userID, email, name, organizationID, organizationTags };
}

/**
 * Build full Qoder credentials from a Personal Access Token.
 * Exchanges the PAT for a job token, resolves identity, and encodes the PAT
 * into the refresh field so the token can be re-exchanged on expiry.
 */
export async function credentialsFromPat(pat: string, mode: string = getQoderMode()): Promise<OAuthCredentials> {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode);
  const { userID, email, name, organizationID, organizationTags } = await fetchUserInfo(jobToken, mode);
  const machineID = getMachineId();
  const defaults = qoderIdentityDefaults(mode);

  return {
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    access: jobToken,
    expires: expiresAt - 5 * 60 * 1000, // 5 min buffer
    userID,
    email: email || defaults.email,
    name: name || defaults.name,
    machineID,
    // 组织信息进凭据是因为签名层要用：它决定是否发 `Cosy-Organization-*`，也是 `info`
    // 明文的一部分（台账差异第 8、14 行）。omp 的 AuthStorage 原样保存多余字段，
    // userID / machineID 已经是这么带过来的。
    organizationID,
    organizationTags,
  } as OAuthCredentials;
}
