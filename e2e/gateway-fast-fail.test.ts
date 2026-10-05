import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { CliResult, TestEnv } from "./helpers/index.js";
import type { FakeDriverScript } from "./fake-driver/types.js";

/**
 * ADR 0009 §4 end to end, with real processes: a gateway daemon, worker daemons that dial it
 * over a real WebSocket, and the CLI an agent would use. A request no worker can serve fails at
 * once with the right code instead of waiting.
 *
 * Every request below has no `--no-wait` and no `--timeout`, the case that used to wait for ever.
 * The CLI call carries a deadline of its own, so a request that waits fails here by name instead
 * of hanging the suite.
 */

const FAST = { timeout: 20_000 };
const EXIT_NO_CAPACITY = 11;
const EXIT_UNSERVABLE = 12;

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: string;
  readonly catalog: readonly unknown[];
}

async function startGateway() {
  const port = await freeLoopbackPort();
  // `driver: "none"`: a gateway starts no drivers (ADR 0005 §2).
  const gateway = await withDaemon({
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
    driver: "none",
  });
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const uplink = { token: secret, url: `ws://127.0.0.1:${port}` };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    gateway,
    join: (label: string, script: FakeDriverScript, extraConfig: Record<string, unknown> = {}) =>
      // Seeded before the daemon starts: a worker reports its catalog as its uplink opens.
      withDaemon({
        configOverrides: { gateway: { ...uplink, label }, ...extraConfig },
        driverScript: script,
        fakeDriverPlatforms: ["ios"],
      }),
  };
}

async function workersOf(gateway: TestEnv): Promise<WorkerView[]> {
  const listed = await gateway.cli(["worker", "list", "--json"]);
  expect(listed.code).toBe(0);
  return (listed.json as { workers: WorkerView[] }).workers;
}

/** Waits until `labels` are all connected with a catalog read, and returns their ids by label. */
async function waitForWorkers(
  gateway: TestEnv,
  labels: readonly string[],
): Promise<Record<string, string>> {
  let ids: Record<string, string> = {};
  await waitFor(
    async () => {
      const workers = await workersOf(gateway);
      const ready = labels.map((label) =>
        workers.find(
          (worker) =>
            worker.label === label &&
            worker.connection === "connected" &&
            worker.catalog.length > 0,
        ),
      );
      if (ready.some((worker) => worker === undefined)) return false;
      ids = Object.fromEntries(ready.map((worker) => [worker?.label ?? "", worker?.id ?? ""]));
      return true;
    },
    { label: `workers ${labels.join(", ")} connected with their catalogs`, timeout: 30_000 },
  );
  return ids;
}

const IPHONE_17 = { availableOsVersions: ["26.0"], knownModels: ["iPhone 17"] };
const IPHONE_16 = { availableOsVersions: ["26.0"], knownModels: ["iPhone 16"] };

function lease(
  gateway: TestEnv,
  agent: string,
  device: string,
  extra: readonly string[] = [],
): Promise<CliResult> {
  return gateway.cli(
    [
      "lease",
      "--platform",
      "ios",
      "--device",
      device,
      "--os",
      "26.0",
      "--agent-id",
      agent,
      ...extra,
    ],
    FAST,
  );
}

function expectFailure(result: CliResult, code: string, exit: number): void {
  expect(result.error, result.stderr).toMatchObject({ code });
  expect(result.code).toBe(exit);
}

describe("a gateway fails a request no worker can serve at once", () => {
  it("fails a request for a model, a runtime, or a platform no worker has, and lets the same requester ask again", async () => {
    const { gateway, join } = await startGateway();
    // 27.0 is installed, but iPhone 17 pairs with 26.0 only.
    await join("worker-a", {
      ios: {
        ...IPHONE_17,
        availableOsVersions: ["26.0", "27.0"],
        modelRuntimes: { "iPhone 17": ["26.0"] },
      },
    });
    await waitForWorkers(gateway, ["worker-a"]);

    // A model no worker lists.
    expectFailure(
      await lease(gateway, "agent-1", "iPhone 99", ["--detach"]),
      "UNKNOWN_MODEL",
      EXIT_UNSERVABLE,
    );
    // The same requester asks again at once: another answer, not REQUESTER_ALREADY_LEASED.
    expectFailure(
      await lease(gateway, "agent-1", "iPhone 99", ["--detach"]),
      "UNKNOWN_MODEL",
      EXIT_UNSERVABLE,
    );

    // A runtime no worker has, and, with --allow-download, still none: only installed runtimes count.
    const runtime = [
      "--platform",
      "ios",
      "--device",
      "iPhone 17",
      "--os",
      "99.0",
      "--agent-id",
      "agent-1",
    ];
    const missing = await gateway.cli(["lease", ...runtime, "--detach"], FAST);
    expectFailure(missing, "RUNTIME_MISSING", EXIT_UNSERVABLE);
    const download = await gateway.cli(["lease", ...runtime, "--detach", "--allow-download"], FAST);
    expectFailure(download, "RUNTIME_MISSING", EXIT_UNSERVABLE);

    // A runtime a worker has, that no worker pairs with the model asked for.
    const unpaired = await gateway.cli(
      [
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 17",
        "--os",
        "27.0",
        "--agent-id",
        "agent-1",
        "--detach",
      ],
      FAST,
    );
    expectFailure(unpaired, "RUNTIME_MISSING", EXIT_UNSERVABLE);

    // A platform no worker has a driver for.
    const android = await gateway.cli(
      [
        "lease",
        "--platform",
        "android",
        "--device",
        "Pixel 8",
        "--agent-id",
        "agent-1",
        "--detach",
      ],
      FAST,
    );
    expectFailure(android, "NO_DRIVER", EXIT_UNSERVABLE);

    // The fleet still serves what it has, to the requester that was refused five times.
    const granted = await lease(gateway, "agent-1", "iPhone 17", ["--detach"]);
    expect(granted.code, granted.stderr).toBe(0);
    const { lease: held } = granted.json as { lease: { id: string } };
    expect((await gateway.cli(["release", held.id], FAST)).code).toBe(0);
  });

  it("fails a class or range request nothing in the fleet can serve at once, with the code a single worker gives", async () => {
    const { gateway, join } = await startGateway();
    await join("worker-a", {
      ios: {
        availableOsVersions: ["18.4", "26.0"],
        defaultModels: { phone: ["iPhone 17"] },
        knownModels: ["iPhone 17"],
        modelClasses: { "iPhone 17": "phone" },
      },
    });
    await waitForWorkers(gateway, ["worker-a"]);
    const ask = (...args: string[]) =>
      gateway.cli(
        ["lease", "--platform", "ios", ...args, "--agent-id", "agent-1", "--detach"],
        FAST,
      );

    // No worker lists a model of the class.
    const watch = await ask("--class", "watch");
    expectFailure(watch, "UNKNOWN_MODEL", EXIT_UNSERVABLE);
    expect(watch.stderr).toContain("watch");
    // Every model of the class pairs with a runtime outside the range, with or without a download.
    expectFailure(
      await ask("--class", "phone", "--os", "<=17"),
      "RUNTIME_MISSING",
      EXIT_UNSERVABLE,
    );
    expectFailure(
      await ask("--class", "phone", "--os", "<=17", "--allow-download"),
      "RUNTIME_MISSING",
      EXIT_UNSERVABLE,
    );
    // A request that names neither model nor class means phone, and the fleet has one.
    const granted = await ask();
    expect(granted.code, granted.stderr).toBe(0);
    const { lease: held } = granted.json as { lease: { id: string } };
    expect((await gateway.cli(["release", held.id], FAST)).code).toBe(0);
  });

  it("fails the HTTP POST of a request no worker can serve, with allowDownload too", async () => {
    const { baseUrl, gateway, join } = await startGateway();
    await join("worker-a", { ios: IPHONE_17 });
    await waitForWorkers(gateway, ["worker-a"]);
    const minted = await gateway.cli(["token", "create", "--role", "agent"]);
    const headers = {
      authorization: `Bearer ${(minted.json as { secret: string }).secret}`,
      "content-type": "application/json",
    };

    const response = await fetch(`${baseUrl}/v1/lease-requests`, {
      body: JSON.stringify({
        allowDownload: true,
        device: "iPhone 99",
        os: "26.0",
        platform: "ios",
      }),
      headers,
      method: "POST",
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "UNKNOWN_MODEL" } });
  });

  it("fails a request only a drained worker, or only a disconnected worker, can serve", async () => {
    const { gateway, join } = await startGateway();
    await join("worker-17", { ios: IPHONE_17 });
    const away = await join("worker-16", { ios: IPHONE_16 });
    const ids = await waitForWorkers(gateway, ["worker-17", "worker-16"]);

    // worker-17 drained: the only worker that lists iPhone 17 is not taking requests.
    expect((await gateway.cli(["worker", "drain", ids["worker-17"] ?? ""])).code).toBe(0);
    expectFailure(
      await lease(gateway, "agent-1", "iPhone 17", ["--detach"]),
      "NO_CAPACITY",
      EXIT_NO_CAPACITY,
    );
    expect((await gateway.cli(["worker", "undrain", ids["worker-17"] ?? ""])).code).toBe(0);

    // worker-16 gone: a request only it lists fails with NO_CAPACITY, not UNKNOWN_MODEL, while
    // worker-17 still takes requests.
    await away.killDaemon();
    await waitFor(
      async () =>
        (await workersOf(gateway)).find((worker) => worker.label === "worker-16")?.connection ===
        "disconnected",
      { label: "worker-16 disconnected", timeout: 30_000 },
    );
    expectFailure(
      await lease(gateway, "agent-1", "iPhone 16", ["--detach"]),
      "NO_CAPACITY",
      EXIT_NO_CAPACITY,
    );
  });

  it("fails any request with NO_CAPACITY when no worker is connected", async () => {
    const { gateway } = await startGateway();

    expectFailure(
      await lease(gateway, "agent-1", "iPhone 17", ["--detach"]),
      "NO_CAPACITY",
      EXIT_NO_CAPACITY,
    );
  });

  it.each([
    [
      "drained",
      (gateway: TestEnv, _worker: TestEnv, id: string) => gateway.cli(["worker", "drain", id]),
    ],
    ["disconnects", (_gateway: TestEnv, worker: TestEnv) => worker.killDaemon()],
  ] as const)(
    "fails a request waiting for a busy worker with NO_CAPACITY when that worker, the only one able to serve it, %s",
    async (_change, change) => {
      const { gateway, join } = await startGateway();
      const worker = await join(
        "worker-a",
        { ios: IPHONE_17 },
        { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } },
      );
      const ids = await waitForWorkers(gateway, ["worker-a"]);
      const held = await lease(gateway, "agent-holder", "iPhone 17", ["--detach"]);
      expect(held.code, held.stderr).toBe(0);

      // A second requester waits: the worker can serve it and is busy.
      const waiting = gateway.cliBackground([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 17",
        "--os",
        "26.0",
        "--agent-id",
        "agent-waiting",
      ]);
      await waitFor(
        () =>
          waiting
            .progressEvents()
            .some((event) => (event as { stage?: string } | null)?.stage === "queued"),
        { label: "the second request queued behind the busy worker", timeout: 20_000 },
      );

      await change(gateway, worker, ids["worker-a"] ?? "");

      const outcome = await waiting.waitForExit(20_000);
      expectFailure(outcome, "NO_CAPACITY", EXIT_NO_CAPACITY);
    },
  );
});
