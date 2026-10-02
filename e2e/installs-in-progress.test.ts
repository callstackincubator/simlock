import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

interface Install {
  readonly platform: string;
  readonly component: string;
  readonly state: string;
}

interface WorkerView {
  readonly connection: string;
  readonly installs?: readonly Install[];
}

/** The installs a worker's own `simlock status --json` lists. */
async function workerInstalls(worker: TestEnv): Promise<readonly Install[]> {
  const status = await worker.cli(["status", "--json"]);
  expect(status.code, status.stderr).toBe(0);
  return (status.json as { installs: readonly Install[] }).installs;
}

/** The installs the gateway's `simlock worker list --json` shows on its only worker's view. */
async function viewInstalls(gateway: TestEnv): Promise<readonly Install[] | undefined> {
  const listed = await gateway.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: readonly WorkerView[] }).workers[0]?.installs;
}

describe("installs in progress", () => {
  it("shows an install on the worker's status and on its gateway's worker list while it runs, and on neither after it ends", async () => {
    const port = await freeLoopbackPort();
    const gateway = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code, minted.stderr).toBe(0);
    const { secret } = minted.json as { secret: string };
    const worker = await withDaemon({
      configOverrides: { gateway: { token: secret, url: `ws://127.0.0.1:${port}` } },
      driverScript: {
        ios: {
          availableOsVersions: ["18.4"],
          knownModels: ["iPhone 16"],
          // Held open long enough for both CLIs to look at it.
          latencyMs: { installComponent: 8_000 },
        },
      },
    });
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const views = (listed.json as { workers?: readonly WorkerView[] } | undefined)?.workers;
        return views?.[0]?.connection === "connected" && views[0].installs !== undefined;
      },
      { label: "the worker joined the gateway and its first view arrived" },
    );
    expect(await workerInstalls(worker)).toEqual([]);
    expect(await viewInstalls(gateway)).toEqual([]);

    // Through the worker's own socket: a gateway never asks a worker to download.
    const lease = worker.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "19.0",
      "--allow-download",
      "--detach",
    ]);
    const downloading = expect.objectContaining({
      component: "19.0",
      platform: "ios",
      state: "downloading",
    });
    await waitFor(async () => (await workerInstalls(worker)).length === 1, {
      label: "the worker's status lists the install",
    });
    expect(await workerInstalls(worker)).toEqual([downloading]);
    await waitFor(async () => (await viewInstalls(gateway))?.length === 1, {
      label: "the gateway's worker list shows the install",
    });
    expect(await viewInstalls(gateway)).toEqual([downloading]);

    const granted = await lease.waitForExit(30_000);
    expect(granted.code, granted.stderr).toBe(0);
    expect(await workerInstalls(worker)).toEqual([]);
    await waitFor(async () => (await viewInstalls(gateway))?.length === 0, {
      label: "the gateway's worker list drops the install",
    });
  });
});
