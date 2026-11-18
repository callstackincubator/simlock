import { describe, expect, it, vi } from "vitest";
import { type BaselineEntry, SimlockError } from "../contract/index.js";
import {
  catalogFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { GATEWAY_REQUESTER_PREFIX, harness, session } from "./test-dispatcher.js";

describe("GatewayDispatcher", () => {
  describe("a lease request naming a baseline (#1208)", () => {
    const CATALOG = catalogFixture([
      {
        modelClasses: { "Pixel 9": "phone" } as const,
        models: ["Pixel 9"],
        platform: "android",
        runtimes: ["36"],
      },
      {
        modelClasses: { "iPhone 17": "phone" } as const,
        models: ["iPhone 17"],
        platform: "ios",
        runtimes: ["27.0"],
      },
    ]).platforms;
    const checkout: BaselineEntry = {
      mode: "full",
      model: "Pixel 9",
      name: "checkout",
      osVersion: "36",
      platform: "android",
      savedAt: "2026-11-02T13:10:00Z",
      version: 2,
    };
    const smoke: BaselineEntry = {
      ...checkout,
      mode: "slim",
      model: "iPhone 17",
      name: "smoke",
      osVersion: "27.0",
      platform: "ios",
      version: 1,
    };
    const stale = (entry: BaselineEntry) => ({
      ...entry,
      staleReason: "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
    });

    function fleet(baselinesByWorker: Record<string, readonly BaselineEntry[]>) {
      const rig = harness();
      const clients: Record<string, ScriptedWorkerClient> = {};
      for (const [workerId, baselines] of Object.entries(baselinesByWorker)) {
        const client = new ScriptedWorkerClient();
        clients[workerId] = client;
        rig.directory.add(workerId, client);
        rig.workers.connected(workerId, undefined, "0.3.0");
        rig.workers.refresh(workerId, {
          baselines: [...baselines],
          capacity: statusFixture().capacity,
          catalog: CATALOG,
          devices: [],
          downloads: { policy: "on-request" },
          health: "running",
          leases: [],
          queueDepth: 0,
        });
      }
      return { ...rig, clients };
    }

    type Rejected = { readonly code: string; readonly message: string };
    const cases: readonly [
      string,
      Record<string, readonly BaselineEntry[]>,
      Record<string, unknown>,
      { readonly grantedBy: string } | { readonly rejected: Rejected },
      string[]?,
    ][] = [
      [
        "one worker holds it, another has none",
        { wrk_a: [], wrk_b: [checkout] },
        { baseline: "checkout", platform: "android" },
        { grantedBy: "wrk_b" },
      ],
      [
        "an OS range that holds the baseline's OS",
        { wrk_a: [], wrk_b: [checkout] },
        { baseline: "checkout", osVersion: ">=35", platform: "android" },
        { grantedBy: "wrk_b" },
      ],
      [
        "no worker holds a baseline of the name",
        { wrk_a: [checkout], wrk_b: [] },
        { baseline: "nothere", platform: "android" },
        {
          rejected: {
            code: "UNKNOWN_BASELINE",
            message: 'no worker holds a baseline named "nothere"',
          },
        },
      ],
      [
        "every holder differs from the request: the first holder's message",
        { wrk_a: [checkout], wrk_b: [{ ...checkout, osVersion: "35" }] },
        { baseline: "checkout", osVersion: "34", platform: "android" },
        {
          rejected: {
            code: "BASELINE_MISMATCH",
            message: "baseline checkout is Android 36, the request asks for 34",
          },
        },
      ],
      [
        "every holder is stale: the first holder's reason",
        { wrk_a: [stale(smoke)], wrk_b: [{ ...smoke, staleReason: "image is gone" }] },
        { baseline: "smoke", platform: "ios" },
        {
          rejected: {
            code: "BASELINE_STALE",
            message:
              "baseline smoke is stale: runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
          },
        },
      ],
      [
        "every holder is stale and differs: the mismatch is checked first",
        { wrk_a: [stale(smoke)] },
        { baseline: "smoke", mode: "full", platform: "ios" },
        {
          rejected: {
            code: "BASELINE_MISMATCH",
            message: "baseline smoke is slim, the request asks for full",
          },
        },
      ],
      [
        "the only holder is disconnected",
        { wrk_a: [checkout], wrk_b: [] },
        { baseline: "checkout", platform: "android" },
        {
          rejected: {
            code: "NO_CAPACITY",
            message: "No worker in the fleet can currently serve this request",
          },
        },
        ["wrk_a"],
      ],
      [
        "the only fresh holder is disconnected and the other holder is stale",
        { wrk_a: [checkout], wrk_b: [stale(checkout)] },
        { baseline: "checkout", platform: "android" },
        {
          rejected: {
            code: "NO_CAPACITY",
            message: "No worker in the fleet can currently serve this request",
          },
        },
        ["wrk_a"],
      ],
    ];

    it.each(cases)(
      "sends a request naming a baseline only to a worker that holds it, fresh: %s",
      async (_label, baselines, ask, outcome, disconnected = []) => {
        const { clients, dispatcher, workers } = fleet(baselines);
        for (const workerId of disconnected) workers.disconnected(workerId);
        for (const client of Object.values(clients)) {
          client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
        }

        // why: a rejection must come at once, so the request does not opt out of waiting and the answer is read after the queue is flushed; a request that waited instead would have none.
        const answer = dispatcher.dispatch(
          "lease.request",
          ("rejected" in outcome ? ask : { ...ask, noWait: true }) as never,
          session({ role: "agent" }),
        );

        if ("rejected" in outcome) {
          let settled: unknown;
          void answer.catch((error: unknown) => {
            settled = error;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toMatchObject(outcome.rejected);
          for (const client of Object.values(clients)) {
            expect(client.lastRequestLeaseInput).toBeUndefined();
          }
          return;
        }
        const grant = await answer;
        expect(grant.lease.id).toMatch(new RegExp(`^${outcome.grantedBy}\\.`));
        for (const [workerId, client] of Object.entries(clients)) {
          if (workerId === outcome.grantedBy) {
            expect(client.lastRequestLeaseInput).toMatchObject({ baseline: ask["baseline"] });
          } else {
            expect(client.lastRequestLeaseInput).toBeUndefined();
          }
        }
      },
    );

    it.each([
      ["UNKNOWN_BASELINE", "no-baseline"],
      ["BASELINE_MISMATCH", "baseline-mismatch"],
      ["BASELINE_STALE", "baseline-stale"],
    ] as const)(
      "leaves out a holder that answers %s, asks the next holder, ends with that answer when none is left, and names %s for it while the request waits",
      async (code, reason) => {
        const refusal = () =>
          new SimlockError(code, "domain", `${code} from the worker`, {} as never);
        const ask = { baseline: "checkout", noWait: true, platform: "android" } as const;
        const next = fleet({ wrk_a: [checkout], wrk_b: [checkout] });
        next.clients["wrk_a"]?.requestLeaseQueue.push({ error: refusal(), kind: "error" });
        next.clients["wrk_b"]?.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });

        const grant = await next.dispatcher.dispatch(
          "lease.request",
          ask,
          session({ role: "agent" }),
        );

        expect(grant.lease.id).toMatch(/^wrk_b\./);
        expect(next.directory.catalogRefreshCalls).toContain("wrk_a");

        const alone = fleet({ wrk_a: [checkout] });
        alone.clients["wrk_a"]?.requestLeaseQueue.push({ error: refusal(), kind: "error" });

        await expect(
          alone.dispatcher.dispatch("lease.request", ask, session({ role: "agent" })),
        ).rejects.toMatchObject({ code, message: `${code} from the worker` });

        const busy = fleet({ wrk_a: [checkout], wrk_b: [checkout] });
        busy.workers.refresh("wrk_b", { queueDepth: 1 });
        busy.clients["wrk_a"]?.requestLeaseQueue.push({ error: refusal(), kind: "error" });
        void busy.dispatcher.dispatch(
          "lease.request",
          { baseline: "checkout", platform: "android" },
          session({ role: "agent" }),
        );
        await vi.waitFor(async () => {
          const status = await busy.dispatcher.dispatch("status.get", {}, session());
          expect(status.waiting?.[0]?.workers).toContainEqual({ reason, workerId: "wrk_a" });
        });
      },
    );
  });

  describe("a request naming a baseline that waits (#1208)", () => {
    it("waits while its only holder is busy, and status.get names why each other worker is passed over", async () => {
      const entry: BaselineEntry = {
        mode: "full",
        model: "Pixel 9",
        name: "checkout",
        osVersion: "36",
        platform: "android",
        savedAt: "2026-11-02T13:10:00Z",
        version: 2,
      };
      const held: Record<string, { baselines: BaselineEntry[]; queueDepth: number }> = {
        wrk_a: { baselines: [entry], queueDepth: 1 },
        wrk_b: { baselines: [], queueDepth: 0 },
        wrk_c: { baselines: [{ ...entry, staleReason: "image is gone" }], queueDepth: 0 },
        wrk_d: { baselines: [{ ...entry, mode: "slim" }], queueDepth: 0 },
      };
      const { directory, dispatcher, workers } = harness();
      for (const [workerId, view] of Object.entries(held)) {
        directory.add(workerId, new ScriptedWorkerClient());
        workers.connected(workerId, undefined, "0.3.0");
        workers.refresh(workerId, {
          ...view,
          capacity: statusFixture().capacity,
          catalog: catalogFixture([
            {
              modelClasses: { "Pixel 9": "phone" } as const,
              models: ["Pixel 9"],
              platform: "android",
              runtimes: ["36"],
            },
          ]).platforms,
          devices: [],
          downloads: { policy: "on-request" },
          health: "running",
          leases: [],
        });
      }

      void dispatcher.dispatch(
        "lease.request",
        { baseline: "checkout", mode: "full", platform: "android" },
        session({ role: "agent" }),
      );
      await vi.waitFor(async () => {
        const status = await dispatcher.dispatch("status.get", {}, session());
        expect(status.waiting?.[0]?.workers).toEqual([
          { reason: "busy", workerId: "wrk_a" },
          { reason: "no-baseline", workerId: "wrk_b" },
          { reason: "baseline-stale", workerId: "wrk_c" },
          { reason: "baseline-mismatch", workerId: "wrk_d" },
        ]);
      });
    });
  });

  describe("a request naming a baseline held by a starting worker (#1208)", () => {
    it("keeps the starting worker's last baselines for routing, so the request waits instead of failing, and shows none in its view", async () => {
      const { directory, dispatcher, workers } = harness();
      directory.add("wrk_a", new ScriptedWorkerClient());
      workers.connected("wrk_a", undefined, "0.3.0");
      workers.refresh("wrk_a", {
        baselines: [
          {
            mode: "full",
            model: "Pixel 9",
            name: "checkout",
            osVersion: "36",
            platform: "android",
            savedAt: "2026-11-02T13:10:00Z",
            version: 1,
          },
        ],
        capacity: statusFixture().capacity,
        catalog: catalogFixture([
          {
            modelClasses: { "Pixel 9": "phone" } as const,
            models: ["Pixel 9"],
            platform: "android",
            runtimes: ["36"],
          },
        ]).platforms,
        devices: [],
        health: "running",
        leases: [],
        queueDepth: 0,
      });
      workers.refresh("wrk_a", { health: "starting" });

      void dispatcher.dispatch(
        "lease.request",
        { baseline: "checkout", platform: "android" },
        session({ role: "agent" }),
      );

      await vi.waitFor(async () => {
        const status = await dispatcher.dispatch("status.get", {}, session());
        expect(status.waiting).toHaveLength(1);
      });
      expect(workers.view("wrk_a")).not.toHaveProperty("baselines");
    });
  });

  describe("baselines through a gateway (#1208)", () => {
    const entry = (name: string, overrides: Partial<BaselineEntry> = {}): BaselineEntry => ({
      mode: "full",
      model: "Pixel 9",
      name,
      osVersion: "36",
      platform: "android",
      savedAt: "2026-11-02T13:10:00Z",
      version: 1,
      ...overrides,
    });

    function workersWith(baselinesByWorker: Record<string, BaselineEntry[]>) {
      const rig = harness();
      const clients: Record<string, ScriptedWorkerClient> = {};
      for (const [workerId, baselines] of Object.entries(baselinesByWorker)) {
        const client = new ScriptedWorkerClient();
        client.baselines = baselines;
        clients[workerId] = client;
        rig.directory.add(workerId, client);
        rig.workers.connected(workerId, undefined, "0.3.0");
        rig.workers.refresh(workerId, {
          baselines,
          capacity: statusFixture().capacity,
          health: "running",
          queueDepth: 0,
        });
      }
      return { ...rig, clients };
    }

    it("saves a baseline on the worker that holds the lease, with the worker's lease id, and drops the lease from its index, or keeps it when the worker has no live link", async () => {
      const { clients, directory, dispatcher, leaseIndex, workers } = workersWith({
        wrk_a: [],
        wrk_b: [],
      });
      workers.refresh("wrk_a", {
        leases: [
          {
            ...leaseFixture("L7", "dev_1"),
            ownerId: "alice-principal",
            requesterId: `${GATEWAY_REQUESTER_PREFIX}alice`,
          },
        ],
      });

      const saved = await dispatcher.dispatch(
        "baseline.save",
        { leaseId: "wrk_a.L7", name: "checkout", note: "app 4.3" },
        session(),
      );

      expect(clients["wrk_a"]?.savedBaselines).toEqual([
        { leaseId: "L7", name: "checkout", note: "app 4.3" },
      ]);
      expect(clients["wrk_b"]?.savedBaselines).toEqual([]);
      expect(saved).toMatchObject({ baseline: { name: "checkout" }, leaseId: "wrk_a.L7" });
      expect(leaseIndex.resolve("wrk_a.L7")).toBeUndefined();
      expect(directory.catalogRefreshCalls).toEqual(["wrk_a"]);

      // why: a worker that no longer knows the lease drops the index entry; one with no live link answers WORKER_UNREACHABLE and keeps it.
      const gatewayLease = (id: string, deviceId: string) => ({
        ...leaseFixture(id, deviceId),
        ownerId: "alice-principal",
        requesterId: `${GATEWAY_REQUESTER_PREFIX}alice`,
      });
      workers.refresh("wrk_a", { leases: [gatewayLease("L8", "dev_2")] });
      workers.refresh("wrk_b", { leases: [gatewayLease("L9", "dev_3")] });
      expect(leaseIndex.resolve("wrk_a.L8")).toBeDefined();
      const unknown = new SimlockError("UNKNOWN_LEASE", "domain", "no such lease", {
        leaseId: "L8",
      });
      if (clients["wrk_a"] !== undefined) clients["wrk_a"].failWith = unknown;
      await expect(
        dispatcher.dispatch("baseline.save", { leaseId: "wrk_a.L8", name: "x" }, session()),
      ).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });
      expect(leaseIndex.resolve("wrk_a.L8")).toBeUndefined();

      directory.clients.delete("wrk_b");
      await expect(
        dispatcher.dispatch("baseline.save", { leaseId: "wrk_b.L9", name: "x" }, session()),
      ).rejects.toMatchObject({ code: "WORKER_UNREACHABLE" });
      expect(leaseIndex.resolve("wrk_b.L9")).toBeDefined();
    });

    it("lists every worker's baselines, each with its workerId, in worker id order, a disconnected worker's last ones too", async () => {
      const { dispatcher, workers } = workersWith({
        wrk_b: [entry("smoke", { platform: "ios" })],
        wrk_a: [entry("checkout", { version: 2 }), entry("login")],
        wrk_c: [],
      });
      workers.disconnected("wrk_b");

      const listed = await dispatcher.dispatch("baseline.list", {}, session({ role: "agent" }));

      expect(listed.baselines.map(({ name, workerId }) => [workerId, name])).toEqual([
        ["wrk_a", "checkout"],
        ["wrk_a", "login"],
        ["wrk_b", "smoke"],
      ]);
    });

    it("removes a baseline from the worker it names without sending the workerId, and refuses an unknown, a disconnected or no worker, and relays the worker's own refusals", async () => {
      const { clients, directory, dispatcher, workers } = workersWith({
        wrk_a: [entry("smoke")],
        wrk_b: [entry("smoke")],
      });

      await expect(
        dispatcher.dispatch("baseline.remove", { name: "smoke", workerId: "wrk_a" }, session()),
      ).resolves.toMatchObject({ name: "smoke" });
      expect(clients["wrk_a"]?.removedBaselines).toEqual([{ name: "smoke" }]);
      expect(directory.catalogRefreshCalls).toEqual(["wrk_a"]);

      await expect(
        dispatcher.dispatch("baseline.remove", { name: "smoke", workerId: "wrk_x" }, session()),
      ).rejects.toMatchObject({ code: "UNKNOWN_WORKER", message: "Unknown worker: wrk_x" });
      workers.disconnected("wrk_b");
      await expect(
        dispatcher.dispatch("baseline.remove", { name: "smoke", workerId: "wrk_b" }, session()),
      ).rejects.toMatchObject({
        code: "WORKER_NOT_CONNECTED",
        message: "worker wrk_b is not connected",
      });
      await expect(
        dispatcher.dispatch("baseline.remove", { name: "smoke" }, session()),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message:
          "baseline.remove on a gateway needs the worker that holds the baseline: pass --worker <id>",
      });
      expect(clients["wrk_a"]?.removedBaselines).toHaveLength(1);
      expect(clients["wrk_b"]?.removedBaselines).toEqual([]);

      // why: a worker's own refusal reaches the caller with its code and words.
      for (const failure of [
        new SimlockError("BASELINE_IN_USE", "domain", "worker's words", {
          leaseId: "L1",
          name: "smoke",
        }),
        new SimlockError("UNKNOWN_BASELINE", "domain", "worker's words", { name: "smoke" }),
      ]) {
        const client = clients["wrk_a"];
        if (client !== undefined) client.failWith = failure;
        await expect(
          dispatcher.dispatch("baseline.remove", { name: "smoke", workerId: "wrk_a" }, session()),
        ).rejects.toMatchObject({ code: failure.code, message: "worker's words" });
      }

      // why: an uplink that drops under the call is the gateway's WORKER_NOT_CONNECTED, not the client's transport code.
      const client = clients["wrk_a"];
      if (client !== undefined) {
        client.failWith = new SimlockError(
          "DAEMON_CONNECTION_LOST",
          "transport",
          "Daemon connection closed",
          {},
        );
      }
      await expect(
        dispatcher.dispatch("baseline.remove", { name: "smoke", workerId: "wrk_a" }, session()),
      ).rejects.toMatchObject({
        code: "WORKER_NOT_CONNECTED",
        message: "worker wrk_a is not connected",
      });
    });
  });
});
