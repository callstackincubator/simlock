import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

const execFileAsync = promisify(execFile);
const uid = process.getuid?.() ?? 0;

async function launchctlPrint(target: string): Promise<string | undefined> {
  try {
    return (await execFileAsync("launchctl", ["print", target])).stdout;
  } catch {
    return undefined;
  }
}

async function launchctlPrints(target: string): Promise<boolean> {
  return (await launchctlPrint(target)) !== undefined;
}

const loggedIn = process.platform === "darwin" && (await launchctlPrints(`gui/${String(uid)}`));

interface InstallReport {
  readonly service: { readonly name: string; readonly path: string };
}

let installed: InstallReport["service"] | undefined;

afterAll(async () => {
  if (installed === undefined) return;
  await execFileAsync("launchctl", ["bootout", `gui/${String(uid)}/${installed.name}`]).catch(
    () => undefined,
  );
  await rm(installed.path, { force: true });
});

async function answering(env: TestEnv): Promise<boolean> {
  const result = await env.cli(["daemon", "status", "--json"]);
  // why: `daemon status` exits 0 with `{"status":"stopped"}` when nothing listens; only a status
  // report without that marker means a daemon answered.
  return (
    result.code === 0 && (result.json as { status?: unknown } | undefined)?.status !== "stopped"
  );
}

describe.skipIf(!loggedIn)("the launchd service on a Mac", { tags: ["slow"] }, () => {
  it(
    "the installed worker comes back after kill -9 and stays stopped after daemon stop",
    { timeout: 180_000 },
    async () => {
      const env = await withDaemon({ mode: "auto" });
      const install = await env.cli(["daemon", "install", "--json"]);
      expect(install.code, install.stderr).toBe(0);
      const report = install.json as InstallReport;
      installed = report.service;
      expect(existsSync(report.service.path)).toBe(true);
      expect(await answering(env)).toBe(true);

      await env.killDaemon("SIGKILL");
      await waitFor(() => answering(env), {
        interval: 1_000,
        label: "daemon answering again after kill -9",
        timeout: 30_000,
      });

      const stop = await env.cli(["daemon", "stop"]);
      expect(stop.code, stop.stderr).toBe(0);
      let answeredAgain = false;
      const until = Date.now() + 15_000;
      await waitFor(
        async () => {
          if (Date.now() >= until) return true;
          if (await answering(env)) {
            answeredAgain = true;
            return true;
          }
          return false;
        },
        { interval: 1_000, label: "15 s without an answer", timeout: 30_000 },
      );
      // why: the stopped daemon exits 0, which `KeepAlive` with `SuccessfulExit` false leaves alone.
      expect(answeredAgain, "daemon answered after daemon stop").toBe(false);

      const status = await env.cli(["status", "--json"]);
      expect(status.code, status.stderr).toBe(0);
      expect(await answering(env)).toBe(true);
      // why: a daemon spawned outside the service would answer too; launchd reports `running` only
      // for the process it started itself.
      const printed = await launchctlPrint(`gui/${String(uid)}/${report.service.name}`);
      expect(printed, "launchctl print of the service").toMatch(/\bstate = running\b/);

      const uninstall = await env.cli(["daemon", "uninstall", "--json"]);
      expect(uninstall.code, uninstall.stderr).toBe(0);
      expect(existsSync(report.service.path)).toBe(false);
      expect(await launchctlPrints(`gui/${String(uid)}/${report.service.name}`)).toBe(false);
    },
  );
});
