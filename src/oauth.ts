import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  getMachineId,
  getQoderMode,
  getQoderOpenApiUrl,
  isQoderCNMode,
  ProviderUserAgent,
  type QoderIdentity,
  qoderIdentityDefaults,
} from "./cosy.js";
import { loadQoderIdentity, saveQoderIdentity } from "./identity-store.js";
import { interactiveLogin } from "./login.js";
import { updateQoderModelsCache } from "./models.js";
import { credentialsFromPat, decodePatRefresh, isPatRefresh } from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

/** Return the PAT exposed through the environment for a provider mode. */
export function getQoderPatForMode(mode: string): string {
  if (isQoderCNMode(mode)) {
    return process.env.QODERCN_API_KEY || process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PAT || "";
  }
  return process.env.QODER_API_KEY || process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || "";
}

/** Exchange an environment PAT before pi resolves its initial model. */
export async function autoLoginQoderFromEnvironment(providerID: string, mode: string): Promise<void> {
  const pat = getQoderPatForMode(mode);
  if (!pat) return;

  // An explicitly supplied PAT is authoritative. The auth file only stores
  // the exchanged job token, so it cannot tell us whether the environment
  // token changed. Re-exchange it on startup to avoid silently using an old
  // account's credentials.
  const credentials = await credentialsFromPat(pat, mode);

  AuthStorage.create().set(providerID, { type: "oauth", ...credentials });

  const qCreds = credentials as QoderCredentials;
  // omp's auth store keeps only the OAuthCredentials fields it knows, so the
  // identity has to be persisted beside it.
  saveQoderIdentity(mode, qCreds);
  // Wait for the model cache before the provider is registered. This matters
  // for `omp models`, which can exit before background work completes.
  await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode);
}

/**
 * The identity carried inside a refresh string.
 *
 * PAT credentials use `pat|<pat>|<jobRefresh>|<userID>|<machineID>`; OAuth ones
 * use `<refreshToken>|<userID>|<machineID>`. Either layout keeps the identity
 * that omp strips from the credential record itself, so both have to be read.
 */
function identityFromRefresh(refresh: string | undefined): { userID: string; machineID: string } {
  if (!refresh) return { userID: "", machineID: "" };
  if (isPatRefresh(refresh)) {
    const { userID, machineID } = decodePatRefresh(refresh);
    return { userID, machineID };
  }
  const parts = refresh.split("|");
  return { userID: parts[1] || "", machineID: parts[2] || "" };
}

/**
 * The stored Qoder credential, with the identity omp's auth store drops filled
 * back in.
 *
 * omp persists only `access`/`refresh`/`expires`/`email`, dropping the `userID`,
 * `name`, and `machineID` this provider attaches. `userID` and `machineID` come
 * back from the refresh string; `name` only exists in the identity file written
 * at login. Returns null when nothing is stored, letting callers fall through to
 * placeholders.
 */
export function getCachedCredentials(providerID: string, mode: string): QoderCredentials | null {
  let stored: Partial<QoderCredentials> | undefined;
  try {
    stored = AuthStorage.create().get(providerID) as Partial<QoderCredentials> | undefined;
  } catch {
    return null;
  }
  if (!stored?.access) return null;

  const saved = loadQoderIdentity(mode);
  const embedded = identityFromRefresh(stored.refresh);

  return {
    ...stored,
    userID: stored.userID || embedded.userID || saved?.userID || "",
    name: stored.name || saved?.name || "",
    email: stored.email || saved?.email || "",
    machineID: stored.machineID || embedded.machineID || saved?.machineID || "",
  } as QoderCredentials;
}

/** The user-facing identity: everything except the machine's own id. */
export type QoderUserIdentity = Omit<QoderIdentity, "machineID">;

/**
 * Fill an already-loaded credentials object's gaps with the defaults.
 *
 * Pure: no filesystem access, deliberately. `machineID` is excluded because
 * resolving it goes through `getMachineId`, which may create
 * `~/.pi/agent/qoder-machine-id` — a side effect no caller that only needs the
 * user's name/email should trigger. Signing callers use
 * `resolveQoderSigningIdentity` instead.
 *
 * Callers that already hold credentials use this rather than
 * `resolveQoderIdentity` so no second read of auth.json happens.
 */
export function identityFromCredentials(
  creds: Partial<QoderUserIdentity> | null | undefined,
  mode: string,
): QoderUserIdentity {
  const defaults = qoderIdentityDefaults(mode);
  return {
    userID: creds?.userID || defaults.userID,
    name: creds?.name || defaults.name,
    email: creds?.email || defaults.email,
  };
}

/** The user identity behind the stored credential, falling back to placeholders. */
export function resolveQoderIdentity(providerID: string, mode: string): QoderUserIdentity {
  return identityFromCredentials(getCachedCredentials(providerID, mode), mode);
}

/**
 * The full identity COSY signing needs, machine id included.
 *
 * Only for callers that actually sign a request: unlike `resolveQoderIdentity`
 * this resolves `machineID`, which may write `qoder-machine-id` into omp's agent
 * directory on a machine that has no id yet. Reads the credentials exactly once.
 */
export function resolveQoderSigningIdentity(providerID: string, mode: string): QoderIdentity {
  const creds = getCachedCredentials(providerID, mode);
  return {
    ...identityFromCredentials(creds, mode),
    machineID: creds?.machineID || getMachineId(),
  };
}

async function loginQoderForMode(callbacks: OAuthLoginCallbacks, mode: string): Promise<OAuthCredentials> {
  // 1. Try environment variables first (PAT). A PAT (pt-...) must be exchanged
  //    for a short-lived job token before it can be used — credentialsFromPat
  //    handles the exchange + identity resolution.
  const pat = getQoderPatForMode(mode);
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, mode);
      const qCreds = creds as QoderCredentials;
      saveQoderIdentity(mode, qCreds);
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
      return creds;
    } catch {
      // Fall through to interactive login if PAT exchange fails.
    }
  }

  // 2. Interactive login (CN only supports PAT prompt here; global supports device flow fallback)
  const creds = await interactiveLogin(callbacks, mode);

  try {
    const qCreds = creds as QoderCredentials;
    saveQoderIdentity(mode, qCreds);
    updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
  } catch {}

  return creds;
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, getQoderMode());
}

export async function loginQoderCN(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, "cn");
}

export async function refreshQoderToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, getQoderMode());
}

export async function refreshQoderTokenCN(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, "cn");
}

async function refreshQoderTokenForMode(credentials: OAuthCredentials, mode: string): Promise<OAuthCredentials> {
  // PAT-based credentials: re-exchange the stored PAT for a fresh job token.
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (pat) {
      try {
        const refreshed = await credentialsFromPat(pat, mode);
        const qCreds = refreshed as QoderCredentials;
        saveQoderIdentity(mode, qCreds);
        updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
        return refreshed;
      } catch {
        // Fall through to validity extension below.
      }
    }
    return {
      ...credentials,
      expires: Date.now() + 60 * 60 * 1000, // extend 1 hour to retry later
    };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const prev = credentials as Partial<QoderCredentials>;
  const saved = loadQoderIdentity(mode);
  // omp strips these from the credential it persists, so the refresh string's
  // tail and the identity file are the only ways back to them.
  const userID = parts[1] || prev.userID || saved?.userID || "";
  const machineID = parts[2] || prev.machineID || saved?.machineID || getMachineId();
  const prevName = prev.name || saved?.name || "";
  const prevEmail = prev.email || saved?.email || "";

  // Official device-token refresh (`pretty.mjs:115099-115108`): POST to the
  // openapi host's `/api/v1/deviceToken/refresh`, body `{ refresh_token }`
  // (snake_case), headers Content-Type + Accept + `User-Agent: qoder/<version>`,
  // and NO `Authorization`. The plugin's previous endpoint
  // `<center>/algo/api/v3/user/refresh_token` returns 403 "Request discarded"
  // (measured 2026-08-16) and appears nowhere in the 1.1.23 bundle — it is dead.
  // The plugin's User-Agent stays `ProviderUserAgent` on purpose (ledger row 48:
  // the fork self-identifies rather than impersonating the official client).
  const refreshURL = `${getQoderOpenApiUrl(mode)}/api/v1/deviceToken/refresh`;
  // Bare block, not try/catch: a failed refresh must throw, not be swallowed.
  // The old code caught the error and extended validity by an hour, which is how
  // the dead endpoint went unnoticed for so long.
  let response: Response;
  {
    response = await fetch(refreshURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": ProviderUserAgent,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // Official throws on a failed refresh (`pretty.mjs:115105-115107`), it does
      // NOT silently extend. The plugin used to swallow the failure and add an
      // hour, which is exactly how the dead endpoint went unnoticed — extending an
      // already-expired token does not make the next request succeed, it only
      // hides that refresh is broken. Surface it instead.
      const text = await response.text().catch(() => "");
      throw new Error(
        `Qoder device-token refresh failed: ${response.status} ${response.statusText}. ${text.slice(0, 200)}`,
      );
    }

    // Official reads `device_token` / `refresh_token` / `expires_at`
    // (`pretty.mjs:115107`). Accept `token` and `expires_in` too so a gateway that
    // answers in the older shape still works.
    const data = (await response.json()) as {
      device_token?: string;
      token?: string;
      refresh_token?: string;
      expires_at?: string;
      expires_in?: number;
    };

    const newAccess = data.device_token || data.token || "";
    if (!newAccess) {
      throw new Error("Qoder device-token refresh returned no access token");
    }
    const newRefresh = data.refresh_token || refreshToken;

    let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    if (data.expires_at) {
      const parsed = Date.parse(data.expires_at);
      if (!Number.isNaN(parsed)) expireMs = parsed;
    } else if (data.expires_in) {
      expireMs = Date.now() + data.expires_in * 1000;
    }

    const refreshed = {
      ...credentials,
      refresh: `${newRefresh}|${userID}|${machineID}`,
      access: newAccess,
      expires: expireMs - 5 * 60 * 1000,
      userID,
      email: prevEmail,
      name: prevName,
      machineID,
    };

    // omp strips userID/name/machineID from the credential it persists, so the
    // identity is written alongside it here too.
    saveQoderIdentity(mode, refreshed);
    updateQoderModelsCache(newAccess, userID, prevName, prevEmail, mode).catch(() => {});

    return refreshed;
  }
}
