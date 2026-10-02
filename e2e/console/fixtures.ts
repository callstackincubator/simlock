import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as base, expect, type Page } from "@playwright/test";

import { cli, type CliResult } from "../helpers/cli.js";
import { freeLoopbackPort } from "../helpers/port.js";
import { REPO_ROOT } from "../helpers/repo-root.js";
import { waitFor } from "../helpers/wait.js";

/**
 * The browser lane's daemons. Each is a real daemon process with HTTP enabled on a free
 * loopback port and its own `SIMLOCK_HOME`, so nothing here touches the machine's own Simlock.
 * A worker runs the end-to-end suite's fake driver; a gateway runs no drivers at all.
 */

export interface ConsoleDaemon {
  /** The console's address, exactly as `simlock status --json` reports it. */
  readonly url: string;
  /** Runs `simlock` against this daemon, for a test that changes its state (a revoked token). */
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  readonly tokens: {
    readonly operator: string;
    readonly agent: string;
    readonly worker: string;
  };
}

const FAKE_DRIVER_MODULE = join(REPO_ROOT, "dist/e2e/index.js");

async function startDaemon(mode: "worker" | "gateway"): Promise<{
  readonly daemon: ConsoleDaemon;
  readonly stop: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "simlock-console-"));
  const port = await freeLoopbackPort();
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ http: { enabled: true, host: "127.0.0.1", port }, mode }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIMLOCK_HOME: home,
    ...(mode === "worker"
      ? {
          SIMLOCK_DRIVERS_MODULE: FAKE_DRIVER_MODULE,
          SIMLOCK_FAKE_DRIVER_LOG: join(home, "fake-driver-calls.jsonl"),
          SIMLOCK_FAKE_DRIVER_SCRIPT: join(home, "fake-driver-script.json"),
        }
      : {}),
  };
  const socketPath = join(home, "daemon.sock");
  const stop = async () => {
    await cli(["daemon", "stop"], env).catch(() => undefined);
    await waitFor(() => !existsSync(socketPath), { timeout: 10_000 }).catch(() => undefined);
    await rm(home, { force: true, recursive: true });
  };
  try {
    const started = await cli(["daemon", "start"], env, { timeout: 30_000 });
    expect(started.code, started.stderr).toBe(0);
    const status = await cli(["status", "--json"], env);
    const url = (status.json as { daemon: { consoleUrl?: string } }).daemon.consoleUrl;
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    const mint = async (role: string) => {
      const minted = await cli(["token", "create", "--role", role], env);
      expect(minted.code, minted.stderr).toBe(0);
      return (minted.json as { secret: string }).secret;
    };
    const tokens = {
      agent: await mint("agent"),
      operator: await mint("operator"),
      worker: await mint("worker"),
    };
    await waitFor(
      async () => {
        try {
          return (await fetch(new URL("/v1/healthz", url))).ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP listener accepting connections" },
    );
    return { daemon: { cli: (args) => cli(args, env), tokens, url: url ?? "" }, stop };
  } catch (error: unknown) {
    await stop();
    throw error;
  }
}

/**
 * `daemon` is a single host, shared by every test in a Playwright worker, and the base URL every
 * `page.goto` resolves against. `gateway` starts only for a test that asks for it.
 */
export const test = base.extend<object, { daemon: ConsoleDaemon; gateway: ConsoleDaemon }>({
  daemon: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here, even an empty one.
    async ({}, use) => {
      const { daemon, stop } = await startDaemon("worker");
      await use(daemon);
      await stop();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  gateway: [
    // oxlint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      const { daemon, stop } = await startDaemon("gateway");
      await use(daemon);
      await stop();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ daemon }, use) => {
    await use(daemon.url);
  },
});

export { expect };

/** Signs in through the sign-in screen, as an operator would. */
export async function signIn(page: Page, token: string): Promise<void> {
  await page.getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Every navigation entry the shell has, in order. */
export const NAV_LABELS = ["Workers", "Leases", "Waiting", "Attention", "Events"] as const;
