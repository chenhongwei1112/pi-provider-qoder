import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isQoderCNMode } from "./cosy.js";
import { agentPath } from "./paths.js";

/**
 * The Qoder identity fields omp's auth store does not keep.
 *
 * omp persists only the `OAuthCredentials` fields it knows — `access`,
 * `refresh`, `expires`, `email` — and drops the `userID`, `name`, and
 * `machineID` this provider attaches to the credential record. COSY signing
 * rejects an empty `userID` outright (`buildAuthHeaders`), so the identity has
 * to survive independently of the credential.
 *
 * OAuth credentials smuggle `userID` and `machineID` through the refresh string
 * (`<token>|<userID>|<machineID>`), but PAT credentials encode the PAT there
 * instead and cannot. This file is the one source that covers both.
 */
export interface QoderStoredIdentity {
  userID: string;
  name: string;
  email: string;
  machineID: string;
}

const IDENTITY_FIELDS = ["userID", "name", "email", "machineID"] as const;

function identityPath(mode: string): string {
  return agentPath(isQoderCNMode(mode) ? "qoder-cn-identity.json" : "qoder-identity.json");
}

export function loadQoderIdentity(mode: string): Partial<QoderStoredIdentity> | null {
  const path = identityPath(mode);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Partial<QoderStoredIdentity>) : null;
  } catch {
    return null;
  }
}

/**
 * Merge what the caller learned into the stored identity.
 *
 * Empty values are dropped rather than written: a refresh reads `name` back from
 * a credential omp already stripped it from, so it routinely arrives as `""`.
 * Writing that through would erase the real name captured at login.
 *
 * Best-effort by design — a failure here must not break a login or a refresh.
 */
export function saveQoderIdentity(mode: string, identity: Partial<QoderStoredIdentity>): void {
  const updates: Partial<QoderStoredIdentity> = {};
  for (const field of IDENTITY_FIELDS) {
    const value = identity[field];
    if (value) updates[field] = value;
  }
  if (Object.keys(updates).length === 0) return;

  const path = identityPath(mode);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const merged = { ...loadQoderIdentity(mode), ...updates };
    writeFileSync(path, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {}
}
