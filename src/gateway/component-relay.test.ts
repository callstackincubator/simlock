import { describe, expect, it, vi } from "vitest";

import type { ComponentInstallOutput, InstallComponentOptions } from "../admin/index.js";
import { SimlockError } from "../admin/index.js";
import { EventBus } from "../bus/index.js";
import { WORKER_RESULT_MESSAGE_MAX_LENGTH, type ComponentProgress } from "../contract/index.js";
import { FakeClock, MemoryUplinkTransport } from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  INSTALL_BACKSTOP_MARGIN_MS,
  relayComponentInstall,
  type ComponentRelayHooks,
} from "./component-relay.js";
import { MemoryDrainStore } from "./drain-store.js";
import { GatewayService } from "./service.js";
import { catalogFixture, protocolMismatchError, ScriptedWorkerClient } from "./test-support.js";
import type { WorkerView } from "./worker-registry.js";

/** A real `GatewayService` with scripted workers behind its uplinks: the relay reads the same
 * views and drives the same links a gateway daemon does. */
function fleet() {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const transport = new MemoryUplinkTransport();
  const pending: ScriptedWorkerClient[] = [];
  const service = new GatewayService({
    authenticate: async () => "accept",
    clock,
    connect: async () => {
      const client = pending.shift();
      if (client === undefined) throw new Error("no scripted worker was queued for this uplink");
      return client.asClient();
    },
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: 4 * 60 * 60_000,
    principal: "gw:instance-1",
    // Far beyond every clock advance below: a periodic refresh must not be what makes a test pass.
    refreshIntervalMs: 24 * 60 * 60_000,
    retentionMs: 24 * 60 * 60_000,
    uplinks: transport,
  });
  /** Connects a scripted worker's uplink, without waiting for anything. */
  const dial = async (workerId: string, client: ScriptedWorkerClient, label?: string) => {
    pending.push(client);
    return transport.connect({
      token: "join-secret",
      url: "ws://gateway.test",
      workerId,
      ...(label === undefined ? {} : { label }),
    });
  };
  return {
    clock,
    service,
    dial,
    /** Connects a scripted worker and waits until its view carries its config. */
    join: async (workerId: string, client: ScriptedWorkerClient, label?: string) => {
      const workerEnd = await dial(workerId, client, label);
      await vi.waitFor(() =>
        expect(service.workers.view(workerId)?.downloads?.timeoutMs).toBeDefined(),
      );
      return workerEnd;
    },
    install: (
      workers: "all" | string[],
      hooks: ComponentRelayHooks = {},
      component: { readonly platform: "ios" | "android"; readonly version: string } = {
        platform: "android",
        version: "35",
      },
    ) =>
      relayComponentInstall(
        { clock, directory: service, views: service.workers },
        { ...component, workers },
        hooks,
      ),
  };
}

/** A `component.install` answer a test settles by hand. */
function deferredInstall() {
  let resolve!: (output: ComponentInstallOutput) => void;
  let reject!: (error: Error) => void;
  let options: InstallComponentOptions = {};
  const promise = new Promise<ComponentInstallOutput>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return {
    handler: async (_input: unknown, given: InstallComponentOptions) => {
      options = given;
      return promise;
    },
    progress: (progress: ComponentProgress) => options.onProgress?.(progress),
    reject,
    resolve,
  };
}

function installed(version = "35"): ComponentInstallOutput {
  return { component: version, outcome: "installed", platform: "android", version };
}

/** The runtimes a worker's view lists for Android; none for a worker with no catalog read yet. */
function androidRuntimes(view: WorkerView | undefined) {
  return view?.catalog?.find((entry) => entry.platform === "android")?.runtimes;
}

function installCalls(client: ScriptedWorkerClient): string[] {
  return client.calls.filter((call) => call.startsWith("component.install"));
}

function connectionLost(): SimlockError<"DAEMON_CONNECTION_LOST"> {
  return new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Daemon connection closed", {});
}

describe("relayComponentInstall (ADR 0010 §7)", () => {
  it("answers one installed and one refused, each with its worker id, when one worker's policy is never", async () => {
    const harness = fleet();
    await harness.service.start();
    const open = new ScriptedWorkerClient();
    const locked = new ScriptedWorkerClient();
    locked.downloadPolicy = "never";
    locked.installComponentHandler = async () => {
      throw new SimlockError(
        "DOWNLOADS_DISABLED",
        "domain",
        'Downloads are disabled by configuration: downloads.policy is "never"',
        { policy: "never" },
      );
    };
    await harness.join("wrk_a", open, "mac-a");
    await harness.join("wrk_b", locked);

    const { results } = await harness.install("all");

    expect(results).toEqual([
      { label: "mac-a", outcome: "installed", version: "35", workerId: "wrk_a" },
      {
        error: {
          code: "DOWNLOADS_DISABLED",
          message: 'Downloads are disabled by configuration: downloads.policy is "never"',
        },
        outcome: "refused",
        workerId: "wrk_b",
      },
    ]);
    await harness.service.stop();
  });

  it("asks both workers before either answers", async () => {
    const harness = fleet();
    await harness.service.start();
    const first = new ScriptedWorkerClient();
    const second = new ScriptedWorkerClient();
    const firstAnswer = deferredInstall();
    const secondAnswer = deferredInstall();
    first.installComponentHandler = firstAnswer.handler;
    second.installComponentHandler = secondAnswer.handler;
    await harness.join("wrk_a", first);
    await harness.join("wrk_b", second);

    const relay = harness.install(["wrk_a", "wrk_b"]);

    await vi.waitFor(() => {
      expect(installCalls(first)).toEqual(["component.install:android:35"]);
      expect(installCalls(second)).toEqual(["component.install:android:35"]);
    });
    firstAnswer.resolve(installed());
    secondAnswer.resolve(installed());
    expect((await relay).results.map((entry) => entry.outcome)).toEqual(["installed", "installed"]);
    await harness.service.stop();
  });

  it("asks a drained worker, which answers installed and stays drained", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_a", worker);
    await harness.service.workers.setDrained("wrk_a", true);

    const { results } = await harness.install("all");

    expect(results).toEqual([{ outcome: "installed", version: "35", workerId: "wrk_a" }]);
    expect(installCalls(worker)).toEqual(["component.install:android:35"]);
    expect(harness.service.workers.view("wrk_a")?.drained).toBe(true);
    await harness.service.stop();
  });

  it('under "all", asks the connected worker, lists the disconnected one as skipped, and sends it nothing when it reconnects', async () => {
    const harness = fleet();
    await harness.service.start();
    const present = new ScriptedWorkerClient();
    const away = new ScriptedWorkerClient();
    const awayEnd = await harness.join("wrk_a", away);
    await harness.join("wrk_b", present);
    await awayEnd.close();
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("disconnected"),
    );

    const { results } = await harness.install("all");

    // In ascending worker id, skipped or not.
    expect(results).toEqual([
      {
        error: { code: "WORKER_UNREACHABLE", message: "Worker wrk_a is not connected" },
        outcome: "skipped",
        workerId: "wrk_a",
      },
      { outcome: "installed", version: "35", workerId: "wrk_b" },
    ]);
    expect(installCalls(away)).toEqual([]);

    const back = new ScriptedWorkerClient();
    await harness.dial("wrk_a", back);
    await vi.waitFor(() => {
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("connected");
      expect(back.calls).toContain("config.get");
    });
    expect(installCalls(back)).toEqual([]);
    await harness.service.stop();
  });

  it('under "all", skips an incompatible worker and one whose config has not been read', async () => {
    const harness = fleet();
    await harness.service.start();
    const asked = new ScriptedWorkerClient();
    await harness.join("wrk_a", asked);
    const old = new ScriptedWorkerClient();
    old.failWith = protocolMismatchError({ min: 1, max: 1 });
    const unread = new ScriptedWorkerClient();
    unread.hangingCalls.add("config.get");
    unread.installComponentHandler = async () => {
      throw new Error("a worker whose config has not been read was asked");
    };
    // Neither ever carries a config, so neither can go through `join`'s wait.
    await joinWithoutConfig(harness, "wrk_b", old, "incompatible");
    await joinWithoutConfig(harness, "wrk_c", unread, "connected");

    const { results } = await harness.install("all");

    expect(results).toEqual([
      { outcome: "installed", version: "35", workerId: "wrk_a" },
      {
        error: {
          code: "WORKER_UNREACHABLE",
          message: "Worker wrk_b speaks no protocol version this gateway supports",
        },
        outcome: "skipped",
        workerId: "wrk_b",
      },
      {
        error: {
          code: "WORKER_UNREACHABLE",
          message: "Worker wrk_c's config has not been read yet",
        },
        outcome: "skipped",
        workerId: "wrk_c",
      },
    ]);
    expect(installCalls(unread)).toEqual([]);
    await harness.service.stop();
  });

  it("fails with WORKER_UNREACHABLE and asks no worker when a named worker is disconnected", async () => {
    const harness = fleet();
    await harness.service.start();
    const present = new ScriptedWorkerClient();
    const away = new ScriptedWorkerClient();
    await harness.join("wrk_a", present);
    const awayEnd = await harness.join("wrk_b", away);
    await awayEnd.close();
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_b")?.connection).toBe("disconnected"),
    );
    const asking = vi.fn();

    await expect(harness.install(["wrk_a", "wrk_b"], { onAsking: asking })).rejects.toMatchObject({
      code: "WORKER_UNREACHABLE",
      details: { workerId: "wrk_b" },
    });
    expect(installCalls(present)).toEqual([]);
    expect(asking).not.toHaveBeenCalled();
    await harness.service.stop();
  });

  it("fails with WORKER_UNREACHABLE when a named worker's config has not been read", async () => {
    const harness = fleet();
    await harness.service.start();
    const unread = new ScriptedWorkerClient();
    unread.hangingCalls.add("config.get");
    unread.installComponentHandler = async () => {
      throw new Error("a worker whose config has not been read was asked");
    };
    await joinWithoutConfig(harness, "wrk_a", unread, "connected");

    await expect(harness.install(["wrk_a"])).rejects.toMatchObject({
      code: "WORKER_UNREACHABLE",
      message: "Worker wrk_a's config has not been read yet",
    });
    expect(installCalls(unread)).toEqual([]);
    await harness.service.stop();
  });

  it("fails with UNKNOWN_WORKER and asks no worker when a named worker is unknown", async () => {
    const harness = fleet();
    await harness.service.start();
    const present = new ScriptedWorkerClient();
    await harness.join("wrk_a", present);

    await expect(harness.install(["wrk_a", "wrk_nope"])).rejects.toMatchObject({
      code: "UNKNOWN_WORKER",
      details: { workerId: "wrk_nope" },
    });
    expect(installCalls(present)).toEqual([]);
    await harness.service.stop();
  });

  it("answers unknown for a worker whose uplink closes mid-install, leaves the other worker's result alone, and lists the component once that worker reconnects", async () => {
    const harness = fleet();
    await harness.service.start();
    const steady = new ScriptedWorkerClient();
    const dropping = new ScriptedWorkerClient();
    const dropped = deferredInstall();
    dropping.installComponentHandler = dropped.handler;
    await harness.join("wrk_a", steady);
    const droppingEnd = await harness.join("wrk_b", dropping);

    const relay = harness.install("all");
    await vi.waitFor(() => expect(installCalls(dropping)).toHaveLength(1));
    // What the gateway's own client does to every call in flight when the uplink closes.
    await droppingEnd.close();
    dropped.reject(connectionLost());

    expect((await relay).results).toEqual([
      { outcome: "installed", version: "35", workerId: "wrk_a" },
      {
        error: {
          code: "WORKER_UNREACHABLE",
          message:
            "The uplink to worker wrk_b closed before it answered; its install may still be running",
        },
        outcome: "unknown",
        workerId: "wrk_b",
      },
    ]);

    // The worker finished its install on its own; once it reconnects, the catalog says so.
    const back = new ScriptedWorkerClient();
    back.catalog = catalogFixture([{ models: ["Pixel 9"], platform: "android", runtimes: ["35"] }]);
    await harness.dial("wrk_b", back);
    await vi.waitFor(() =>
      expect(androidRuntimes(harness.service.workers.view("wrk_b"))).toEqual(["35"]),
    );
    await harness.service.stop();
  });

  it("answers unknown for a worker that has not answered by its downloads.timeoutMs plus 60 seconds, and drops its late answer", async () => {
    const harness = fleet();
    await harness.service.start();
    const silent = new ScriptedWorkerClient();
    silent.downloadTimeoutMs = 5_000;
    const answer = deferredInstall();
    silent.installComponentHandler = answer.handler;
    await harness.join("wrk_a", silent);
    const progress: unknown[] = [];

    const relay = harness.install("all", {
      onProgress: (update, workerId) => progress.push({ ...update, workerId }),
    });
    const relayState = promiseState(relay);
    await vi.waitFor(() => expect(installCalls(silent)).toHaveLength(1));
    harness.clock.advance(5_000 + INSTALL_BACKSTOP_MARGIN_MS - 1);
    answer.progress({ stage: "waiting" });
    harness.clock.advance(1);
    await vi.waitFor(() => expect(relayState.state).toBe("fulfilled"));
    const { results } = await relay;
    answer.progress({ stage: "downloading" });
    answer.resolve(installed());
    await Promise.resolve();

    expect(results).toEqual([
      {
        error: {
          code: "WORKER_UNREACHABLE",
          message:
            "Worker wrk_a did not answer within its downloads.timeoutMs plus 60s; its install may still be running",
        },
        outcome: "unknown",
        workerId: "wrk_a",
      },
    ]);
    // Heard before the backstop, dropped after it.
    expect(progress).toEqual([{ stage: "waiting", workerId: "wrk_a" }]);
    await harness.service.stop();
  });

  it("measures each worker's backstop from its own downloads.timeoutMs, not one value for the fleet", async () => {
    const harness = fleet();
    await harness.service.start();
    const quick = new ScriptedWorkerClient();
    quick.downloadTimeoutMs = 1_000;
    const patient = new ScriptedWorkerClient();
    patient.downloadTimeoutMs = 100_000;
    const quickAnswer = deferredInstall();
    const patientAnswer = deferredInstall();
    quick.installComponentHandler = quickAnswer.handler;
    patient.installComponentHandler = patientAnswer.handler;
    await harness.join("wrk_a", quick);
    await harness.join("wrk_b", patient);
    const progress: string[] = [];

    const relay = harness.install("all", {
      onProgress: (_update, workerId) => progress.push(workerId),
    });
    await vi.waitFor(() => {
      expect(installCalls(quick)).toHaveLength(1);
      expect(installCalls(patient)).toHaveLength(1);
    });
    // Past the quick worker's backstop, short of the patient one's.
    harness.clock.advance(1_000 + INSTALL_BACKSTOP_MARGIN_MS);
    quickAnswer.progress({ stage: "waiting" });
    patientAnswer.progress({ stage: "waiting" });
    expect(progress).toEqual(["wrk_b"]);
    patientAnswer.resolve(installed());

    expect((await relay).results.map((entry) => [entry.workerId, entry.outcome])).toEqual([
      ["wrk_a", "unknown"],
      ["wrk_b", "installed"],
    ]);
    await harness.service.stop();
  });

  it("leaves no backstop timer behind once every worker has answered", async () => {
    const harness = fleet();
    await harness.service.start();
    await harness.join("wrk_a", new ScriptedWorkerClient());
    await harness.join("wrk_b", new ScriptedWorkerClient());
    const before = harness.clock.pendingTimerCount;

    await harness.install("all");

    expect(harness.clock.pendingTimerCount).toBe(before);
    await harness.service.stop();
  });

  it("answers failed with the worker's own code for an error other than DOWNLOADS_DISABLED", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.installComponentHandler = async () => {
      throw new SimlockError("DOWNLOAD_TIMEOUT", "domain", "The download took too long", {
        timeoutMs: 1,
      } as never);
    };
    await harness.join("wrk_a", worker);

    expect((await harness.install(["wrk_a"])).results).toEqual([
      {
        error: { code: "DOWNLOAD_TIMEOUT", message: "The download took too long" },
        outcome: "failed",
        workerId: "wrk_a",
      },
    ]);
    await harness.service.stop();
  });

  it("answers failed with INTERNAL when the call rejects with something that is not a worker's error", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.installComponentHandler = async () => {
      throw new Error("the answer could not be read");
    };
    await harness.join("wrk_a", worker);

    expect((await harness.install(["wrk_a"])).results).toEqual([
      {
        error: { code: "INTERNAL", message: "the answer could not be read" },
        outcome: "failed",
        workerId: "wrk_a",
      },
    ]);
    await harness.service.stop();
  });

  it("releases every caller that coalesced into one queued refresh once it has run", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    await harness.join("wrk_a", worker);
    const release = worker.holdStatus();
    worker.pushEvent({ event: "device.state-changed" });
    await vi.waitFor(() => expect(worker.calls.at(-1)).toBe("status.get"));
    const link = harness.service.target("wrk_a");
    const released: string[] = [];
    void link?.refresh().then(() => released.push("first"));
    void link?.refresh({ includeCatalog: true }).then(() => released.push("second"));

    release();

    await vi.waitFor(() => expect([...released].sort()).toEqual(["first", "second"]));
    await harness.service.stop();
  });

  it("releases a caller waiting on a queued catalog refresh when the link closes under the refresh ahead of it", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const workerEnd = await harness.join("wrk_a", worker);
    const release = worker.holdStatus();
    worker.pushEvent({ event: "device.state-changed" });
    await vi.waitFor(() => expect(worker.calls.at(-1)).toBe("status.get"));
    let waited = false;
    void harness.service
      .target("wrk_a")
      ?.refresh({ includeCatalog: true })
      .then(() => {
        waited = true;
      });

    await workerEnd.close();
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_a")?.connection).toBe("disconnected"),
    );
    release();

    await vi.waitFor(() => expect(waited).toBe(true));
    // Released without a refresh: nothing more is read over a closed link.
    expect(worker.calls.filter((call) => call === "catalog.get")).toHaveLength(1);
    await harness.service.stop();
  });

  it("cuts a worker's error message to the contract's bound, and fails an answer that does not fit it", async () => {
    const harness = fleet();
    await harness.service.start();
    const wordy = new ScriptedWorkerClient();
    wordy.installComponentHandler = async () => {
      throw new SimlockError("DOWNLOAD_TIMEOUT", "domain", "x".repeat(5_000), {} as never);
    };
    const odd = new ScriptedWorkerClient();
    odd.installComponentHandler = async () => installed("9".repeat(65));
    await harness.join("wrk_a", wordy);
    await harness.join("wrk_b", odd);

    const { results } = await harness.install("all");

    expect(results[0]?.error?.message).toBe("x".repeat(WORKER_RESULT_MESSAGE_MAX_LENGTH));
    expect(results[1]).toEqual({
      error: {
        code: "INTERNAL",
        message: "Worker wrk_b answered with a result outside the contract",
      },
      outcome: "failed",
      workerId: "wrk_b",
    });
    await harness.service.stop();
  });

  it("lists the component in that worker's catalog by the time it answers installed, before any periodic refresh", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.catalog = catalogFixture([
      { models: ["Pixel 9"], platform: "android", runtimes: ["34"] },
    ]);
    worker.installComponentHandler = async (input) => {
      worker.catalog = catalogFixture([
        { models: ["Pixel 9"], platform: "android", runtimes: ["34", "35"] },
      ]);
      return installed(input.version);
    };
    await harness.join("wrk_a", worker);

    await harness.install(["wrk_a"]);

    expect(androidRuntimes(harness.service.workers.view("wrk_a"))).toEqual(["34", "35"]);
    await harness.service.stop();
  });

  it("answers only after a catalog refresh that started after the answer, even when another refresh was running and one without the catalog was queued", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.catalog = catalogFixture([
      { models: ["Pixel 9"], platform: "android", runtimes: ["34"] },
    ]);
    await harness.join("wrk_a", worker);
    let release: (() => void) | undefined;
    worker.installComponentHandler = async (input) => {
      worker.catalog = catalogFixture([
        { models: ["Pixel 9"], platform: "android", runtimes: ["34", "35"] },
      ]);
      // A device event starts a refresh without the catalog, which then sits on `status.get`;
      // a second one queues another refresh without the catalog behind it.
      release = worker.holdStatus();
      worker.pushEvent({ event: "device.state-changed" });
      worker.pushEvent({ event: "device.state-changed" });
      return installed(input.version);
    };
    const runtimesNow = () => androidRuntimes(harness.service.workers.view("wrk_a"));

    const runtimesWhenAnswered = harness.install(["wrk_a"]).then(runtimesNow);
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();

    expect(await runtimesWhenAnswered).toEqual(["34", "35"]);
    await harness.service.stop();
  });

  it("relays progress from two workers, each with its own worker id", async () => {
    const harness = fleet();
    await harness.service.start();
    const first = new ScriptedWorkerClient();
    const second = new ScriptedWorkerClient();
    first.installComponentHandler = async (input, options) => {
      options.onProgress?.({ fraction: 0.25, stage: "downloading" });
      return installed(input.version);
    };
    second.installComponentHandler = async (input, options) => {
      options.onProgress?.({ stage: "waiting" });
      return installed(input.version);
    };
    await harness.join("wrk_a", first);
    await harness.join("wrk_b", second);
    const progress: unknown[] = [];

    await harness.install("all", {
      onProgress: (update, workerId) => progress.push({ ...update, workerId }),
    });

    expect(progress).toEqual(
      expect.arrayContaining([
        { fraction: 0.25, stage: "downloading", workerId: "wrk_a" },
        { stage: "waiting", workerId: "wrk_b" },
      ]),
    );
    expect(progress).toHaveLength(2);
    await harness.service.stop();
  });
});

/** Joins a worker that never ends up with a config in its view, and waits for its connection
 * state instead. */
async function joinWithoutConfig(
  harness: ReturnType<typeof fleet>,
  workerId: string,
  client: ScriptedWorkerClient,
  connection: "connected" | "incompatible",
): Promise<void> {
  await harness.dial(workerId, client);
  await vi.waitFor(() => {
    const view = harness.service.workers.view(workerId);
    expect(view?.connection).toBe(connection);
    // A connected worker's first refresh has asked for its config, which never answers.
    if (connection === "connected") expect(client.calls).toContain("config.get");
  });
}
