import { describe, expect, it, vi } from "vitest";
import { negotiateProtocolVersion, PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  catalogFixture,
  protocolMismatchError,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { eventNames, fleet, REFRESH_MS, RecordingLogger } from "./test-service.js";

const previousProtocol = {
  min: PROTOCOL_VERSION_RANGE.min - 1,
  max: PROTOCOL_VERSION_RANGE.max - 1,
};

describe("GatewayService", () => {
  describe("waiting requests on the view", () => {
    it("a worker's lease.queued event refreshes its view's waiting list on the gateway", async () => {
      const worker = new ScriptedWorkerClient();
      const harness = fleet();
      await harness.service.start();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.downloads).toBeDefined(),
      );
      expect(harness.service.workers.view("wrk_1")?.waiting).toEqual([]);

      const queued = {
        createdAt: 500,
        id: "req_1",
        queuePosition: 1,
        requesterId: "local-agent",
        spec: { model: "iPhone 17", platform: "ios" as const },
        stage: "queued" as const,
      };
      worker.status = statusFixture({ queueDepth: 1, waiting: [queued] });
      worker.pushEvent({ event: "lease.queued" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.waiting).toEqual([queued]),
      );
      await harness.service.stop();
    });
  });

  describe("installs in progress on the view (ADR 0010 §7)", () => {
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 500,
      state: "downloading" as const,
      waiters: 1,
    };

    async function joined(worker: ScriptedWorkerClient) {
      const harness = fleet();
      await harness.service.start();
      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(worker.subscribed).toBe(true));
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.downloads).toBeDefined(),
      );
      return harness;
    }

    it("shows a worker's install after component.install-started and drops it after component.installed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      const harness = await joined(worker);
      expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]);

      worker.status = statusFixture({ installs: [install] });
      worker.pushEvent({ event: "component.install-started" });
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.installs).toEqual([install]),
      );

      worker.status = statusFixture({ installs: [] });
      worker.pushEvent({ event: "component.installed" });
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]));

      await harness.service.stop();
    });

    it("shows a worker's update after daemon.update-started and its failure after daemon.update-failed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      const harness = await joined(worker);
      const base = statusFixture();
      const update = {
        forced: false,
        from: "0.3.0",
        stage: "installing",
        startedAt: 1_000,
        to: "0.4.0",
      } as const;
      const failure = {
        at: 2_000,
        from: "0.3.0",
        message: "npm failed",
        stage: "installing",
        to: "0.4.0",
      } as const;

      worker.status = { ...base, daemon: { ...base.daemon, update } };
      worker.pushEvent({ event: "daemon.update-started" });
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.update).toEqual(update));

      worker.status = { ...base, daemon: { ...base.daemon, lastUpdateFailure: failure } };
      worker.pushEvent({ event: "daemon.update-failed" });
      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")).toMatchObject({
          lastUpdateFailure: failure,
          update: null,
        }),
      );

      await harness.service.stop();
    });

    it("drops a worker's install after component.install-failed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      worker.status = statusFixture({ installs: [install] });
      const harness = await joined(worker);
      expect(harness.service.workers.view("wrk_1")?.installs).toEqual([install]);

      worker.status = statusFixture({ installs: [] });
      worker.pushEvent({ event: "component.install-failed" });

      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.installs).toEqual([]));
      await harness.service.stop();
    });

    it("lists the new runtime in the view's catalog after component.installed, without waiting for the periodic refresh", async () => {
      const worker = new ScriptedWorkerClient();
      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
      ]);
      const harness = await joined(worker);

      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0", "26.4"] },
      ]);
      worker.pushEvent({ event: "component.installed" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.runtimes).toEqual([
          "26.0",
          "26.4",
        ]),
      );
      await harness.service.stop();
    });

    it.each(["baseline.saved", "baseline.removed", "baseline.stale"])(
      "lists the worker's baselines in its view, and reads them again after %s, without waiting for the periodic refresh",
      async (event) => {
        const entry = {
          mode: "full" as const,
          model: "Pixel 9",
          name: "checkout",
          osVersion: "36",
          platform: "android" as const,
          savedAt: "2026-11-02T13:10:00Z",
          version: 1,
        };
        const worker = new ScriptedWorkerClient();
        worker.baselines = [entry];
        const harness = await joined(worker);
        expect(harness.service.workers.view("wrk_1")?.baselines).toEqual([entry]);

        worker.baselines = [{ ...entry, version: 2 }];
        worker.pushEvent({ event });

        await vi.waitFor(() =>
          expect(harness.service.workers.view("wrk_1")?.baselines?.[0]?.version).toBe(2),
        );
        await harness.service.stop();
      },
    );

    it("re-reads the catalog for a component.installed that queues behind a refresh in flight, and keeps it when another event queues after it", async () => {
      const worker = new ScriptedWorkerClient();
      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] },
      ]);
      const harness = await joined(worker);

      worker.catalog = catalogFixture([
        { models: ["iPhone 17"], platform: "ios", runtimes: ["26.0", "26.4"] },
      ]);
      worker.pushEvent({ event: "lease.granted" });
      worker.pushEvent({ event: "component.installed" });
      worker.pushEvent({ event: "lease.released" });

      await vi.waitFor(() =>
        expect(harness.service.workers.view("wrk_1")?.catalog?.[0]?.runtimes).toEqual([
          "26.0",
          "26.4",
        ]),
      );
      await harness.service.stop();
    });

    it("yields a view with no installs, still connected, for a worker whose status has no installs field", async () => {
      const worker = new ScriptedWorkerClient();
      const { installs: _absent, ...withoutInstalls } = statusFixture();
      worker.status = { ...withoutInstalls, queueDepth: 3 };

      const harness = await joined(worker);

      const view = harness.service.workers.view("wrk_1");
      expect(view?.queueDepth).toBe(3);
      expect(view?.installs).toEqual([]);
      expect(view?.connection).toBe("connected");
      await harness.service.stop();
    });

    it("truncates a worker's installs to 16 entries and an over-long component to 64 characters, rather than storing them as sent", async () => {
      const worker = new ScriptedWorkerClient();
      worker.status = statusFixture({
        installs: Array.from({ length: 20 }, (_, index) => ({
          ...install,
          component: `${String(index).padStart(2, "0")}${"x".repeat(100)}`,
          since: index,
        })),
      });

      const harness = await joined(worker);

      const installs = harness.service.workers.view("wrk_1")?.installs ?? [];
      expect(installs).toHaveLength(16);
      expect(installs.map((entry) => entry.component)).toEqual(
        Array.from({ length: 16 }, (_, index) =>
          `${String(index).padStart(2, "0")}${"x".repeat(100)}`.slice(0, 64),
        ),
      );
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("connected");
      await harness.service.stop();
    });
  });

  describe("warning on a worker's lower lease.maxTtlMs (ADR 0005 §15)", () => {
    it("warns once the joining worker's own config.get reports a lower cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker, "mac-mini-1");
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      const warning = logger.warnings.find((entry) => entry.fields?.workerId === "wrk_1");
      expect(warning?.fields).toMatchObject({
        gatewayMaxTtlMs: 3_600_000,
        label: "mac-mini-1",
        workerMaxTtlMs: 1_800_000,
      });

      await harness.service.stop();
    });

    it("does not warn when the joining worker's own cap is at or above the gateway's", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 3_600_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());

      expect(logger.warnings.some((entry) => entry.fields?.workerId === "wrk_1")).toBe(false);

      await harness.service.stop();
    });

    it("does not repeat the warning on the periodic tick's re-read of an unchanged cap", async () => {
      const logger = new RecordingLogger();
      const harness = fleet({ leaseMaxTtlMs: 3_600_000, logger });
      await harness.service.start();
      const worker = new ScriptedWorkerClient();
      worker.leaseMaxTtlMs = 1_800_000;

      await harness.join("wrk_1", worker);
      await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.lease).toBeDefined());
      const warningsAfterJoin = logger.warnings.filter(
        (entry) => entry.fields?.workerId === "wrk_1",
      ).length;
      expect(warningsAfterJoin).toBe(1);

      const callsBefore = worker.calls.filter((call) => call === "config.get").length;
      harness.clock.advance(REFRESH_MS);
      await vi.waitFor(() =>
        expect(worker.calls.filter((call) => call === "config.get").length).toBeGreaterThan(
          callsBefore,
        ),
      );

      expect(logger.warnings.filter((entry) => entry.fields?.workerId === "wrk_1").length).toBe(
        warningsAfterJoin,
      );

      await harness.service.stop();
    });
  });

  it("puts the warm pool block a worker's status read carries on its view", async () => {
    const warmPool = { enabled: true, reserveRunning: { android: 0, ios: 2 }, targets: [] };
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.status = statusFixture({ warmPool });

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.warmPool).toEqual(warmPool),
    );

    await harness.service.stop();
  });

  it("marks a worker that speaks only the previous protocol version incompatible with both ranges, and asks it nothing else", async () => {
    const previous = { min: 5, max: 5 };
    expect(negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, previous)).toBeUndefined();
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(previous);

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: previous },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);

    await harness.service.stop();
  });

  it("reads an incompatible worker's update with daemon.update query on the tick and keeps the last view when the query fails", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError({ min: 5, max: 5 });
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );
    const update = {
      forced: false,
      from: "0.2.0",
      stage: "installing",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    const lastUpdateFailure = {
      at: 500,
      from: "0.1.0",
      message: "npm failed",
      stage: "installing",
      to: "0.2.0",
    } as const;
    worker.updateAnswer = {
      ...worker.updateAnswer,
      lastUpdateFailure,
      latestVersion: "0.4.0",
      update,
    };

    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")).toMatchObject({
        lastUpdateFailure,
        latestVersion: "0.4.0",
        update,
      }),
    );
    expect(worker.updateInputs).toEqual([{ query: true }]);

    worker.updateFailWith = new Error("worker went quiet");
    harness.clock.advance(REFRESH_MS);
    await vi.waitFor(() => expect(worker.updateInputs).toHaveLength(2));
    expect(harness.service.workers.view("wrk_1")).toMatchObject({ latestVersion: "0.4.0", update });

    await harness.service.stop();
  });

  it("does not let a replaced incompatible link's late update query overwrite its successor's view", async () => {
    const harness = fleet();
    await harness.service.start();
    const stale = new ScriptedWorkerClient();
    stale.failWith = protocolMismatchError({ min: 5, max: 5 });
    await harness.join("wrk_1", stale);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );
    let answerQuery: (() => void) | undefined;
    stale.updateDaemon = () =>
      new Promise((resolve) => {
        answerQuery = () =>
          resolve({
            ...stale.updateAnswer,
            update: {
              forced: false,
              from: "0.2.0",
              stage: "installing",
              startedAt: 1,
              to: "0.4.0",
            },
          });
      });
    harness.clock.advance(REFRESH_MS);
    await vi.waitFor(() => expect(answerQuery).toBeDefined());

    await harness.join("wrk_1", new ScriptedWorkerClient("admin", "9.9.9"));
    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.version).toBe("9.9.9"));
    answerQuery?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      connection: "connected",
      update: null,
      version: "9.9.9",
    });
    await harness.service.stop();
  });

  it("shows a worker's update, last update failure and latest version from its status, and a later status without an update clears it", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    const update = {
      forced: false,
      from: "0.3.0",
      leases: 2,
      stage: "waiting",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    const failure = {
      at: 500,
      from: "0.2.0",
      message: "npm failed",
      stage: "installing",
      to: "0.3.0",
    } as const;
    const base = statusFixture();
    worker.status = {
      ...base,
      daemon: { ...base.daemon, lastUpdateFailure: failure, latestVersion: "0.4.0", update },
    };
    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")).toMatchObject({
        lastUpdateFailure: failure,
        latestVersion: "0.4.0",
        update,
      }),
    );

    worker.status = { ...worker.status, daemon: { ...worker.status.daemon, update: null } };
    harness.clock.advance(REFRESH_MS);

    await vi.waitFor(() => expect(harness.service.workers.view("wrk_1")?.update).toBeNull());
    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      lastUpdateFailure: failure,
      latestVersion: "0.4.0",
    });

    await harness.service.stop();
  });

  it("a worker advertising protocol 10 is incompatible on the gateway and nothing it pushes reaches the gateway's bus", async () => {
    const worker10 = { min: 10, max: 10 };
    expect(negotiateProtocolVersion(PROTOCOL_VERSION_RANGE, worker10)).toBeUndefined();
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(worker10);
    worker.subscribeDespiteFailure = true;

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );
    worker.pushEvent({ event: "lease.granted", payload: { leaseId: "l1" } });

    expect(worker.subscribed).toBe(false);
    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: worker10 },
    });
    expect(eventNames(harness.events)).not.toContain("lease.granted");

    await harness.service.stop();
  });

  it("marks a worker incompatible when hello finds no overlapping range, and asks it nothing else", async () => {
    const harness = fleet();
    await harness.service.start();
    const worker = new ScriptedWorkerClient();
    worker.failWith = protocolMismatchError(previousProtocol);

    await harness.join("wrk_1", worker);
    await vi.waitFor(() =>
      expect(harness.service.workers.view("wrk_1")?.connection).toBe("incompatible"),
    );

    expect(harness.service.workers.view("wrk_1")).toMatchObject({
      protocol: { gateway: PROTOCOL_VERSION_RANGE, worker: previousProtocol },
    });
    expect(worker.calls).toEqual(["status.get"]);
    expect(worker.subscribed).toBe(false);
    expect(eventNames(harness.events)).not.toContain("worker.rejected");
    expect(eventNames(harness.events)).not.toContain("worker.connected");

    await harness.service.stop();
  });
});
