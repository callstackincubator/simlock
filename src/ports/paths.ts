import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolves simlock's data directory (config.json, state.json, daemon.sock, daemon.log,
 * and the device roots under `devices/`). `SIMLOCK_HOME` overrides the default
 * `~/.simlock` -- used by tests that need an isolated data directory per daemon instance,
 * and by anyone running multiple independent simlock installs on one machine.
 *
 * A relative `SIMLOCK_HOME` is resolved here, once, against the process that read it.
 * Everything else derived from it would otherwise appear to work -- Node resolves a
 * relative path against the cwd on every call -- while the device root derived from it
 * would be refused `not-absolute`, silently costing a platform for a reason nobody is
 * looking at. It also means the daemon and the CLI that auto-launched it agree on one
 * directory even if they are standing somewhere different.
 */
export function resolveSimlockHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SIMLOCK_HOME;
  return configured === undefined ? join(homedir(), ".simlock") : resolve(configured);
}
