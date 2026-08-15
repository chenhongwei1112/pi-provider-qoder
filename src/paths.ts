import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A path inside omp's agent directory.
 *
 * `PI_CODING_AGENT_DIR` relocates the entire agent base — auth store, model
 * caches, sessions — so anything this extension persists must follow it instead
 * of hard-coding a home-relative path. `omp --profile <name>` moves the base to
 * `~/.omp/profiles/<name>/agent`, which reaches us through the same variable.
 */
export function agentPath(...segments: string[]): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return join(override || join(homedir(), ".omp", "agent"), ...segments);
}
