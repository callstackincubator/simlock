import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves simlock's data directory (config.json, state.json, daemon.sock, daemon.log).
 * `SIMLOCK_HOME` overrides the default `~/.simlock` -- used by tests that need an
 * isolated data directory per daemon instance, and by anyone running multiple
 * independent simlock installs on one machine.
 */
export function resolveSimlockHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIMLOCK_HOME ?? join(homedir(), ".simlock");
}
