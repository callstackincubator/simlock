import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves pitlane's data directory (config.json, state.json, daemon.sock, daemon.log).
 * `PITLANE_HOME` overrides the default `~/.pitlane` -- used by tests that need an
 * isolated data directory per daemon instance, and by anyone running multiple
 * independent pitlane installs on one machine.
 */
export function resolvePitlaneHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PITLANE_HOME ?? join(homedir(), ".pitlane");
}
