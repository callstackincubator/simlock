import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cli, type CliResult } from "../helpers/cli.js";
import { REPO_ROOT } from "../helpers/repo-root.js";
import { waitFor } from "../helpers/wait.js";

export const PROXY_URL = "http://127.0.0.1:4180";
export const GATEWAY_PORT = 4700;
export const ISSUER = "http://127.0.0.1:5556/dex";
export const CLIENT_ID = "simlock-real-proxy";
export const ALICE = { email: "alice@example.test", password: "password" } as const;

export interface LaneDaemon {
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  dispose(): Promise<void>;
}

const FAKE_DRIVER_MODULE = join(REPO_ROOT, "dist/e2e/index.js");

// why: fake devices use no real memory, so a nominal budget keeps the RAM gate from refusing
// a lease on a small runner; the lane's worker only has to join, but the config must be valid.
const FAKE_CAPACITY = {
  limits: {
    maxRunning: 8,
    ios: { maxDevices: 8, maxRunning: 8 },
    android: { maxDevices: 8, maxRunning: 8 },
  },
  ramBudget: { iosBytesPerDevice: 1024 * 1024, androidBytesPerDevice: 1024 * 1024 },
};

async function startDaemon(
  mode: "worker" | "gateway",
  config: Readonly<Record<string, unknown>>,
): Promise<LaneDaemon> {
  const home = await mkdtemp(join(tmpdir(), "simlock-real-proxy-"));
  await writeFile(join(home, "config.json"), JSON.stringify({ mode, ...config }));
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
  const dispose = async () => {
    await cli(["daemon", "stop"], env).catch(() => undefined);
    await waitFor(() => !existsSync(socketPath), { timeout: 10_000 }).catch(() => undefined);
    await rm(home, { force: true, recursive: true });
  };
  try {
    const started = await cli(["daemon", "start"], env, { timeout: 30_000 });
    if (started.code !== 0) throw new Error(`daemon start failed: ${started.stderr}`);
  } catch (error: unknown) {
    await dispose();
    throw error;
  }
  return { cli: (args) => cli(args, env), dispose };
}

export async function startGateway(): Promise<LaneDaemon> {
  const gateway = await startDaemon("gateway", {
    http: {
      enabled: true,
      host: "127.0.0.1",
      port: GATEWAY_PORT,
      proxyAuth: {
        audience: CLIENT_ID,
        header: "x-id-token",
        issuer: ISSUER,
        jwksUrl: `${ISSUER}/keys`,
      },
    },
  });
  try {
    await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "gateway HTTP listener" },
    );
  } catch (error: unknown) {
    await gateway.dispose();
    throw error;
  }
  return gateway;
}

export async function startWorker(join_: {
  readonly gatewayUrl: string;
  readonly token: string;
}): Promise<LaneDaemon> {
  return startDaemon("worker", {
    ...FAKE_CAPACITY,
    gateway: { label: "real-proxy-worker", token: join_.token, url: join_.gatewayUrl },
  });
}
