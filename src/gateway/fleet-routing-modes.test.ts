import { describe, expect, it } from "vitest";

import { SimlockError } from "../contract/index.js";
import { createRoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  grantFixture,
  physicalDeviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { buildFleet, connectWorker, REQUEST, requestOptions, tick } from "./test-fleet.js";

type Modes = ("slim" | "full")[];

interface WorkerSpec {
  /** why: absent is a worker that sends no `modes` field: it serves both. */
  readonly modes?: Modes;
  readonly baseline?: "slim" | "full";
  readonly physical?: true;
}

function fleet(specs: Readonly<Record<string, WorkerSpec>>) {
  const made = buildFleet();
  const clients: Record<string, ScriptedWorkerClient> = {};
  for (const [id, spec] of Object.entries(specs)) {
    const client = new ScriptedWorkerClient();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    clients[id] = client;
    made.directory.add(id, client);
    connectWorker(made.workers, id);
    made.workers.refresh(id, {
      capacity: statusFixture().capacity,
      catalog: catalogFixture([
        {
          models: ["iPhone 17"],
          platform: "ios",
          runtimes: ["26.0"],
          ...(spec.modes === undefined ? {} : { modes: spec.modes }),
        },
      ]).platforms,
      ...(spec.physical === true ? { devices: [physicalDeviceFixture("dev_p", "ready")] } : {}),
      ...(spec.baseline === undefined
        ? {}
        : {
            baselines: [
              {
                mode: spec.baseline,
                model: "iPhone 17",
                name: "b",
                osVersion: "26.0",
                platform: "ios" as const,
                savedAt: "2026-11-02T13:10:00Z",
                version: 1,
              },
            ],
          }),
    });
  }
  return { ...made, clients };
}

// why: the coordinator's tests, split by subject; they build the fleet from its test-support files, which index.ts does not export.
describe("FleetLeaseCoordinator routes an iOS lease by the modes each worker serves (ADR 0082 §4)", () => {
  it("routes an iOS lease through a gateway by mode: a named or baseline mode goes only to a worker that serves it, and the lease fails at once when none does", async () => {
    const cases: {
      label: string;
      request: {
        baseline?: string;
        mode?: "slim" | "full";
        physical?: boolean;
        model?: string;
        osVersion?: string;
      };
      workers: Record<string, WorkerSpec>;
      routedTo?: string;
      rejected?: string;
    }[] = [
      {
        label: "--mode full, one slim-only worker",
        request: { mode: "full" },
        workers: { wrk_a: { modes: ["slim"] } },
        rejected:
          'No worker serves full iOS simulators; ask for a slim one (--mode slim, or mode: "slim")',
      },
      {
        label: "slim-only plus a worker serving both",
        request: { mode: "full" },
        workers: { wrk_a: { modes: ["slim"] }, wrk_b: { modes: ["slim", "full"] } },
        routedTo: "wrk_b",
      },
      {
        label: "slim-only plus a worker with no modes field",
        request: { mode: "full" },
        workers: { wrk_a: { modes: ["slim"] }, wrk_b: {} },
        routedTo: "wrk_b",
      },
      {
        label: "--mode slim, one full-only worker",
        request: { mode: "slim" },
        workers: { wrk_a: { modes: ["full"] } },
        rejected:
          'No worker serves slim iOS simulators; ask for a full one (--mode full, or mode: "full")',
      },
      {
        label: "no mode, only a slim-only worker",
        request: {},
        workers: { wrk_a: { modes: ["slim"] } },
        routedTo: "wrk_a",
      },
      {
        label: "a full baseline on a slim-only worker",
        request: { baseline: "b" },
        workers: { wrk_a: { baseline: "full", modes: ["slim"] } },
        rejected: 'Baseline "b" is full, and no worker that holds it serves full iOS simulators',
      },
      {
        label: "--physical to a slim-only worker",
        request: { mode: "full", model: "iPhone 15 Pro", osVersion: "18.4", physical: true },
        workers: { wrk_a: { modes: ["slim"], physical: true } },
        routedTo: "wrk_a",
      },
    ];

    for (const { label, request, workers: specs, routedTo, rejected } of cases) {
      const { clients, coordinator } = fleet(specs);
      const outcome = await Promise.race([
        coordinator.request({ ...REQUEST, ...request }, requestOptions()).then(
          () => "granted",
          (error: unknown) => error,
        ),
        tick().then(() => "waiting"),
      ]);
      const received = Object.entries(clients)
        .filter(([, client]) => client.lastRequestLeaseInput !== undefined)
        .map(([id]) => id);
      if (rejected !== undefined) {
        expect(outcome, label).toMatchObject({
          code: "MODE_UNAVAILABLE",
          details: { mode: request.mode ?? "full", platform: "ios", served: [] },
          message: rejected,
        });
        expect(received, label).toEqual([]);
      } else {
        expect(outcome, label).toBe("granted");
        expect(received, label).toEqual([routedTo]);
      }
    }

    const { workers } = fleet({ wrk_a: { modes: ["slim"] }, wrk_b: {} });
    expect(
      createRoutingPolicy("warm-then-free").explain({ ...REQUEST, mode: "full" }, workers.views()),
    ).toMatchObject([
      { filter: { reason: "mode-unavailable" }, workerId: "wrk_a" },
      { workerId: "wrk_b" },
    ]);
  });

  it("walks on to another worker when a worker answers MODE_UNAVAILABLE before a progress push, and gives the caller the worker's own refusal when none is left", async () => {
    const refusal = new SimlockError(
      "MODE_UNAVAILABLE",
      "domain",
      "This worker does not serve full iOS simulators",
      { mode: "full", platform: "ios", served: ["slim"] },
    );

    // why: both views are stale, with no `modes` field, so only the worker's own refusal says it serves slim alone.
    const both = fleet({ wrk_a: {}, wrk_b: {} });
    both.clients["wrk_a"]?.requestLeaseQueue.splice(0, 1, { error: refusal, kind: "error" });
    const granted = await both.coordinator.request({ ...REQUEST, mode: "full" }, requestOptions());

    expect(granted.lease.worker?.id).toBe("wrk_b");
    expect(both.directory.catalogRefreshCalls).toEqual(["wrk_a"]);

    const alone = fleet({ wrk_a: {} });
    alone.clients["wrk_a"]?.requestLeaseQueue.splice(0, 1, { error: refusal, kind: "error" });
    const outcome = await Promise.race([
      alone.coordinator.request({ ...REQUEST, mode: "full" }, requestOptions()).then(
        () => "granted",
        (error: unknown) => error,
      ),
      tick().then(() => "waiting"),
    ]);

    expect(outcome).toMatchObject({
      code: "MODE_UNAVAILABLE",
      details: { mode: "full", platform: "ios", served: ["slim"] },
      message: "This worker does not serve full iOS simulators",
    });
  });
});
