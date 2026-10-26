import { describe, expect, it } from "vitest";

import {
  mintJoinToken,
  type TestEnv,
  waitFor,
  withDaemon,
  withHttpDaemon,
} from "./helpers/index.js";

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly downloads?: { readonly timeoutMs?: number };
  readonly installs?: readonly { readonly component: string; readonly state: string }[];
}

interface WorkerResult {
  readonly workerId: string;
  readonly label?: string;
  readonly outcome: string;
  readonly version?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

async function listWorkers(gateway: TestEnv): Promise<readonly WorkerView[]> {
  const listed = await gateway.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { workers: readonly WorkerView[] }).workers;
}

function idOf(workers: readonly WorkerView[], label: string): string {
  const worker = workers.find((candidate) => candidate.label === label);
  if (worker === undefined) throw new Error(`No worker labelled ${label}`);
  return worker.id;
}

async function androidRuntimeWorkers(gateway: TestEnv, runtime: string): Promise<unknown> {
  const catalog = await gateway.cli(["catalog", "--platform", "android", "--json"]);
  expect(catalog.code, catalog.stderr).toBe(0);
  const android = (
    catalog.json as {
      platforms: { platform: string; runtimeWorkers?: Record<string, string[]> }[];
    }
  ).platforms.find((entry) => entry.platform === "android");
  return android?.runtimeWorkers?.[runtime];
}

describe("simlock component install through a gateway", () => {
  it("asks every worker, shows the install in worker list while it runs, reports each by id, refuses on the worker set to never, the gateway's catalog lists the component for the one that installed it, and an agent token gets 403 over HTTP", async () => {
    const { env: gateway, port } = await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      role: "gateway",
      driver: "none",
    }));
    const url = `ws://127.0.0.1:${port}`;
    const androidScript = {
      android: {
        availableOsVersions: ["34"],
        installProgress: [50],
        knownModels: ["Pixel 9"],
        // why: Held open long enough for `worker list` to see it.
        latencyMs: { installComponent: 3_000 },
      },
    };
    await withDaemon({
      configOverrides: { gateway: { label: "open", token: await mintJoinToken(gateway), url } },
      driverScript: androidScript,
    });
    await withDaemon({
      configOverrides: {
        downloads: { policy: "never" },
        gateway: { label: "locked", token: await mintJoinToken(gateway), url },
      },
      driverScript: androidScript,
    });
    let workers: readonly WorkerView[] = [];
    await waitFor(
      async () => {
        workers = await listWorkers(gateway);
        return (
          workers.length === 2 &&
          workers.every(
            (worker) =>
              worker.connection === "connected" && worker.downloads?.timeoutMs !== undefined,
          )
        );
      },
      { label: "both workers joined and their config was read", timeout: 30_000 },
    );
    const open = idOf(workers, "open");
    const locked = idOf(workers, "locked");
    expect(await androidRuntimeWorkers(gateway, "35")).toBeUndefined();

    const agent = await gateway.cli(["token", "create", "--role", "agent"]);
    expect(agent.code, agent.stderr).toBe(0);
    const refused = await fetch(`http://127.0.0.1:${port}/v1/components/install`, {
      body: JSON.stringify({ platform: "android", version: "35", workers: "all" }),
      headers: {
        authorization: `Bearer ${(agent.json as { secret: string }).secret}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect((await listWorkers(gateway)).flatMap((worker) => worker.installs ?? [])).toEqual([]);

    const running = gateway.cliBackground([
      "component",
      "install",
      "android",
      "35",
      "--all-workers",
    ]);
    await waitFor(
      async () =>
        (await listWorkers(gateway))
          .find((worker) => worker.id === open)
          ?.installs?.some((entry) => entry.component === "35") === true,
      { label: "the gateway's worker list shows the install on the open worker" },
    );
    const install = await running.waitForExit(30_000);

    expect(install.code, install.stderr).toBe(15);
    const results = (install.json as { results: readonly WorkerResult[] }).results;
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      [...results].sort((left, right) => (left.workerId < right.workerId ? -1 : 1)),
    );
    expect(results.find((entry) => entry.workerId === open)).toEqual({
      label: "open",
      outcome: "installed",
      version: "35",
      workerId: open,
    });
    expect(results.find((entry) => entry.workerId === locked)).toMatchObject({
      error: { code: "DOWNLOADS_DISABLED" },
      label: "locked",
      outcome: "refused",
      workerId: locked,
    });
    const progress = install.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["stage"] !== undefined);
    expect(progress).toContainEqual({ fraction: 0.5, stage: "downloading", workerId: open });

    // why: Read straight after the command, with no wait: the relay refreshed the catalog first.
    expect(await androidRuntimeWorkers(gateway, "35")).toEqual([open]);
  });

  it("refuses component install with no worker flag on a gateway with exit 2, telling the operator to name workers", async () => {
    const { env: gateway } = await withHttpDaemon((port) => ({
      configOverrides: { http: { host: "127.0.0.1", port } },
      role: "gateway",
      driver: "none",
    }));

    const result = await gateway.cli(["component", "install", "ios", "26.4"]);

    expect(result.code, result.stderr).toBe(2);
    expect(result.error?.code).toBe("UNSUPPORTED_IN_GATEWAY_MODE");
    expect(result.error?.message).toContain("--worker <id> or --all-workers");
  });
});
