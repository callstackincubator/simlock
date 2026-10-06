import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as base, expect, type Page } from "@playwright/test";
import { type RawData, WebSocket } from "ws";

import type { FakeDriverScript } from "../fake-driver/types.js";
import { cli, cliBackground, type CliBackgroundHandle, type CliResult } from "../helpers/cli.js";
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

/** A daemon a test drives itself: its CLI, and stopping and starting it in place. */
export interface RunningDaemon extends ConsoleDaemon {
  readonly port: number;
  /** The daemon's unix socket, for a test that drives it with the programmatic client. */
  readonly socketPath: string;
  cliBackground(args: readonly string[]): CliBackgroundHandle;
  /** Replaces the fake driver's script. A daemon reads its host facts and catalog at start. */
  writeDriverScript(script: FakeDriverScript): Promise<void>;
  /** `simlock daemon stop`, keeping the home: `start()` brings the same daemon back. */
  stop(): Promise<void>;
  /** `simlock daemon start` on the same home, port and tokens. */
  start(): Promise<void>;
  /** Stops the daemon and deletes its home. */
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Merged over the config the lane writes: HTTP on a free port, and the mode. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The fake driver's script, written before the daemon starts. */
  readonly driverScript?: FakeDriverScript;
}

const FAKE_DRIVER_MODULE = join(REPO_ROOT, "dist/e2e/index.js");

/**
 * Pins a worker's capacity to the flow, not the machine running it, as the end-to-end suite
 * does: fake devices use no real memory, so a nominal per-device budget keeps the RAM gate from
 * refusing a lease on a small CI runner.
 */
const FAKE_CAPACITY = {
  limits: {
    maxRunning: 8,
    ios: { maxDevices: 8, maxRunning: 8 },
    android: { maxDevices: 8, maxRunning: 8 },
  },
  ramBudget: { iosBytesPerDevice: 1024 * 1024, androidBytesPerDevice: 1024 * 1024 },
};

export async function startDaemon(
  mode: "worker" | "gateway",
  options: StartOptions = {},
): Promise<RunningDaemon> {
  const home = await mkdtemp(join(tmpdir(), "simlock-console-"));
  const port = await freeLoopbackPort();
  const scriptPath = join(home, "fake-driver-script.json");
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      ...(mode === "worker" ? FAKE_CAPACITY : {}),
      http: { enabled: true, host: "127.0.0.1", port },
      mode,
      ...options.config,
    }),
  );
  if (options.driverScript !== undefined) {
    await writeFile(scriptPath, JSON.stringify(options.driverScript));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIMLOCK_HOME: home,
    ...(mode === "worker"
      ? {
          SIMLOCK_DRIVERS_MODULE: FAKE_DRIVER_MODULE,
          SIMLOCK_FAKE_DRIVER_LOG: join(home, "fake-driver-calls.jsonl"),
          SIMLOCK_FAKE_DRIVER_SCRIPT: scriptPath,
        }
      : {}),
  };
  const socketPath = join(home, "daemon.sock");
  const background = new Set<CliBackgroundHandle>();
  const stop = async () => {
    await cli(["daemon", "stop"], env).catch(() => undefined);
    await waitFor(() => !existsSync(socketPath), { timeout: 10_000 }).catch(() => undefined);
  };
  const start = async () => {
    const started = await cli(["daemon", "start"], env, { timeout: 30_000 });
    expect(started.code, started.stderr).toBe(0);
  };
  const dispose = async () => {
    for (const handle of background) handle.kill("SIGTERM");
    await stop();
    await rm(home, { force: true, recursive: true });
  };
  try {
    await start();
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
    return {
      cli: (args) => cli(args, env),
      cliBackground(args) {
        const handle = cliBackground(args, env);
        background.add(handle);
        return handle;
      },
      dispose,
      port,
      socketPath,
      start,
      stop,
      tokens,
      url: url ?? "",
      writeDriverScript: (script) => writeFile(scriptPath, JSON.stringify(script)),
    };
  } catch (error: unknown) {
    await dispose();
    throw error;
  }
}

/** A gateway and the workers that joined it, each labelled. */
export interface Fleet {
  readonly gateway: RunningDaemon;
  readonly workers: readonly RunningDaemon[];
}

/**
 * Starts a gateway and one worker per entry of `workers`, each joined to it with its label, and
 * waits until the gateway lists every one of them as connected and has read it: a worker that is
 * still `starting`, or not yet read, has no capacity or catalog in its view, and a test that
 * leases through the gateway or reads a card's capacity right away would see that gap.
 */
export async function startFleet(
  workers: readonly { readonly label: string; readonly driverScript?: FakeDriverScript }[],
): Promise<Fleet> {
  const gateway = await startDaemon("gateway");
  const started: RunningDaemon[] = [];
  try {
    for (const worker of workers) {
      started.push(
        await startDaemon("worker", {
          config: {
            gateway: {
              label: worker.label,
              token: gateway.tokens.worker,
              url: `ws://127.0.0.1:${gateway.port}`,
            },
          },
          ...(worker.driverScript === undefined ? {} : { driverScript: worker.driverScript }),
        }),
      );
    }
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const views = (
          listed.json as {
            workers?: readonly { capacity?: unknown; connection: string; health?: string }[];
          }
        ).workers;
        return (
          views?.length === workers.length &&
          views.every(
            (view) =>
              view.connection === "connected" &&
              view.health !== "starting" &&
              view.capacity !== undefined,
          )
        );
      },
      { label: "every worker connected to the gateway and read by it" },
    );
    return { gateway, workers: started };
  } catch (error: unknown) {
    await disposeFleet({ gateway, workers: started });
    throw error;
  }
}

export async function disposeFleet(fleet: Fleet): Promise<void> {
  await Promise.all(fleet.workers.map((worker) => worker.dispose()));
  await fleet.gateway.dispose();
}

/** The protocol range the stand-in below claims: older than any this gateway speaks. */
export const OLD_PROTOCOL = { max: 3, min: 1 } as const;

/**
 * A worker too old for the gateway, without building an old Simlock: it dials the gateway's
 * uplink with a real join token, as a worker does, and answers the gateway's `hello` the way a
 * daemon speaking only protocol {@link OLD_PROTOCOL} does. The gateway then lists it as
 * `incompatible` with both ranges. Resolves once the uplink is open; call the result to hang up.
 */
export async function joinOldWorker(
  gateway: RunningDaemon,
  identity: { readonly id: string; readonly label: string },
): Promise<() => void> {
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/uplink`, {
    headers: {
      authorization: `Bearer ${gateway.tokens.worker}`,
      "x-simlock-worker-id": identity.id,
      "x-simlock-worker-label": encodeURIComponent(identity.label),
    },
  });
  socket.on("message", (data: RawData) => {
    for (const line of rawText(data).split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as {
        id?: number;
        type?: string;
        payload?: { protocolRange?: unknown };
      };
      if (frame.type !== "hello" || frame.id === undefined) continue;
      const reply = {
        error: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          details: {
            client: frame.payload?.protocolRange,
            daemon: OLD_PROTOCOL,
            daemonVersion: "0.0.1",
          },
          message: "No protocol version in common",
        },
        id: frame.id,
        ok: false,
      };
      socket.send(`${JSON.stringify(reply)}\n`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return () => socket.close();
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

/**
 * `daemon` is a single host, shared by every test in a Playwright worker, and the base URL every
 * `page.goto` resolves against. `gateway` starts only for a test that asks for it.
 */
export const test = base.extend<object, { daemon: RunningDaemon; gateway: RunningDaemon }>({
  daemon: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here, even an empty one.
    async ({}, use) => {
      const daemon = await startDaemon("worker");
      await use(daemon);
      await daemon.dispose();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  gateway: [
    // oxlint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      const daemon = await startDaemon("gateway");
      await use(daemon);
      await daemon.dispose();
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
