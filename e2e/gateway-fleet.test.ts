import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";

/**
 * ADR 0005 #117 end to end, with real processes: a gateway daemon, two worker daemons that dial
 * it over a real WebSocket, and the CLI an operator would actually use.
 *
 * What this flow proves that the unit suites cannot: the uplink is a real network connection on
 * the gateway's own HTTP port, the join token is a real credential minted on the gateway and
 * read from a worker's config file, and `simlock status` against the gateway aggregates two
 * separate machines' registries.
 */

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: "connected" | "disconnected" | "incompatible";
  readonly drained: boolean;
  readonly capacity?: { readonly ios: { readonly limit: number } };
  readonly catalog: readonly { readonly platform: string; readonly models: readonly string[] }[];
}

interface StatusView {
  readonly daemon: { readonly mode: string };
  readonly capacity: { readonly ios: { readonly limit: number } };
  readonly workers?: readonly WorkerView[];
}

async function listWorkers(gateway: TestEnv): Promise<WorkerView[]> {
  const result = await gateway.cli(["worker", "list", "--json"]);
  expect(result.code).toBe(0);
  return (result.json as { workers: WorkerView[] }).workers;
}

/** Polls the *gateway*, never a worker: the gateway's own view is what this flow is about. */
async function waitForWorkers(
  gateway: TestEnv,
  predicate: (workers: WorkerView[]) => boolean,
  label: string,
): Promise<WorkerView[]> {
  let workers: WorkerView[] = [];
  await waitFor(
    async () => {
      workers = await listWorkers(gateway);
      return predicate(workers);
    },
    { label, timeout: 30_000 },
  );
  return workers;
}

/** A worker's per-platform limit, or 0 if the view has no capacity yet. Out here so the test
 * body below stays a sequence of assertions rather than a chain of fallbacks. */
function iosLimit(worker: WorkerView | undefined): number {
  return worker?.capacity?.ios.limit ?? 0;
}

/** The id of the worker an operator would recognize by `label`. Throws rather than degrading
 * to `""`, which would silently turn "no such worker" into a request for one. */
function idOf(workers: readonly WorkerView[], label: string): string {
  const worker = workers.find((candidate) => candidate.label === label);
  if (worker === undefined) throw new Error(`No worker labelled ${label}`);
  return worker.id;
}

function connectionOf(workers: readonly WorkerView[], label: string): string | undefined {
  return workers.find((worker) => worker.label === label)?.connection;
}

function iosModels(json: unknown): readonly string[] {
  const platforms = (json as { platforms: { platform: string; models?: string[] }[] }).platforms;
  return platforms.find((entry) => entry.platform === "ios")?.models ?? [];
}

describe("gateway fleet", () => {
  it("two workers join, status aggregates them, a kill disconnects one, drain flags the other", async () => {
    const port = await freeLoopbackPort();
    // `driver: "none"`: a gateway starts no drivers and warns about every worker-only key in
    // its config (ADR 0005 §2), so it gets no fake-driver wiring and no capacity seeding.
    const gateway = await withDaemon({
      configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });

    // 1. The gateway mints a join token. `--role worker` is what makes it a join token and
    //    nothing else: it opens an uplink and no `/v1` route.
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code).toBe(0);
    const { secret, token } = minted.json as { secret: string; token: { role: string } };
    expect(token.role).toBe("worker");

    // 2. Two workers, each with its own SIMLOCK_HOME (and therefore its own instance identity),
    //    join with the same token and the gateway's base URL.
    const fleetConfig = { gateway: { token: secret, url: `ws://127.0.0.1:${port}` } };
    const workerA = await withDaemon({
      configOverrides: { gateway: { ...fleetConfig.gateway, label: "worker-a" } },
    });
    await workerA.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const workerB = await withDaemon({
      configOverrides: { gateway: { ...fleetConfig.gateway, label: "worker-b" } },
    });
    await workerB.driverScript.set({
      ios: { knownModels: ["iPhone 17"], availableOsVersions: ["18.4"] },
    });

    const joined = await waitForWorkers(
      gateway,
      (workers) =>
        workers.length === 2 && workers.every((worker) => worker.connection === "connected"),
      "both workers connected to the gateway",
    );
    expect(joined.map((worker) => worker.label).sort()).toEqual(["worker-a", "worker-b"]);
    // Two machines, two identities: the ids are the workers' own `instance.json`, never a name
    // the gateway invented or a label an operator chose.
    expect(new Set(joined.map((worker) => worker.id)).size).toBe(2);

    // 3. `simlock status` against the gateway is the same shape one machine returns, summed.
    const status = await gateway.cli(["status", "--json"]);
    expect(status.code).toBe(0);
    const statusView = status.json as StatusView;
    expect(statusView.daemon.mode).toBe("gateway");
    expect(statusView.workers).toHaveLength(2);
    expect(iosLimit(joined[0])).toBeGreaterThan(0);
    expect(statusView.capacity.ios.limit).toBe(iosLimit(joined[0]) + iosLimit(joined[1]));

    // 4. The catalog is the union, and says which worker each model came from.
    await waitFor(
      async () => {
        const models = iosModels((await gateway.cli(["catalog", "--json"])).json);
        return models.includes("iPhone 16") && models.includes("iPhone 17");
      },
      { label: "the gateway's catalog unions both workers", timeout: 30_000 },
    );
    const catalog = await gateway.cli(["catalog", "--json"]);
    const iosCatalog = (
      catalog.json as {
        platforms: { platform: string; modelWorkers?: Record<string, string[]> }[];
      }
    ).platforms.find((entry) => entry.platform === "ios");
    expect(iosCatalog?.modelWorkers?.["iPhone 16"]).toEqual([idOf(joined, "worker-a")]);

    // 5. Killing a worker flips its view without anyone polling it: the uplink closing *is* the
    //    signal (ADR 0005 §6). The gateway's own backstop tick is 30s, and this must not need
    //    it -- so a short deadline here is the assertion.
    await workerA.killDaemon();
    const surviving = await waitForWorkers(
      gateway,
      (workers) => connectionOf(workers, "worker-a") === "disconnected",
      "the killed worker's view flipped to disconnected",
    );
    // The other worker is untouched, and the dead one's view is kept rather than dropped.
    expect(surviving).toHaveLength(2);
    expect(connectionOf(surviving, "worker-b")).toBe("connected");

    // 6. Draining flags the surviving worker (what #118's dispatch will honour), and the flag
    //    is on the view an operator reads back.
    const workerBId = idOf(surviving, "worker-b");
    const drain = await gateway.cli(["worker", "drain", workerBId]);
    expect(drain.code).toBe(0);
    expect(drain.json).toEqual({ drained: true, workerId: workerBId });
    expect((await listWorkers(gateway)).find((worker) => worker.id === workerBId)?.drained).toBe(
      true,
    );

    // 7. Removing a *connected* worker is refused; the disconnected one is forgotten.
    const refused = await gateway.cli(["worker", "remove", workerBId]);
    expect(refused.error?.code).toBe("WORKER_CONNECTED");
    const workerAId = idOf(surviving, "worker-a");
    const removed = await gateway.cli(["worker", "remove", workerAId]);
    expect(removed.code).toBe(0);
    expect(await listWorkers(gateway)).toHaveLength(1);

    // 8. A worker's own events reach the gateway's buffer with its workerId attached, which is
    //    what makes `simlock events` against a gateway a fleet-wide view (ADR 0005 §22).
    const events = await gateway.events();
    const connectedFacts = events.filter((event) => event.event === "worker.connected");
    expect(connectedFacts).toHaveLength(2);
    const workerFacts = events.filter(
      (event) => (event.payload as { workerId?: string }).workerId === workerBId,
    );
    expect(workerFacts.length).toBeGreaterThan(0);

    await workerB.cli(["daemon", "stop"]);
  });

  it("refuses an uplink whose token is not a worker join token", async () => {
    const port = await freeLoopbackPort();
    const gateway = await withDaemon({
      configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });
    // An operator token is a real credential that opens no uplink (ADR 0005 §25). The worker
    // keeps retrying at its backoff cap rather than giving up, so what this asserts is the
    // gateway's side: it never becomes a worker.
    const operator = await gateway.cli(["token", "create", "--role", "operator"]);
    const { secret } = operator.json as { secret: string };
    await withDaemon({
      configOverrides: { gateway: { token: secret, url: `ws://127.0.0.1:${port}` } },
    });

    await waitFor(
      async () => {
        const events = await gateway.events();
        return events.some(
          (event) =>
            event.event === "worker.rejected" &&
            (event.payload as { reason?: string }).reason === "forbidden",
        );
      },
      { label: "the gateway reported the refused uplink", timeout: 20_000 },
    );

    expect(await listWorkers(gateway)).toEqual([]);
  });
});
