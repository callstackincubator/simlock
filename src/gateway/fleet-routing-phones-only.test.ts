import { describe, expect, it } from "vitest";

import { buildFleet, requestOptions } from "./test-fleet.js";
import {
  catalogFixture,
  grantFixture,
  physicalDeviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import type { WorkerRegistry } from "./worker-registry.js";

type Entry = Parameters<typeof catalogFixture>[0][number];

const PHONES_ONLY = (platform: "android" | "ios"): Entry => ({
  models: [],
  platform,
  runtimes: [],
  virtualDevices: false,
});
const EMULATORS = (platform: "android" | "ios"): Entry => ({
  models: [platform === "ios" ? "iPhone 17" : "Pixel 9"],
  platform,
  runtimes: [platform === "ios" ? "26.0" : "36"],
});

function connect(workers: WorkerRegistry, id: string, entry: Entry, physical = false): void {
  workers.connected(id, undefined, "0.3.0");
  workers.refresh(id, {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([entry]).platforms,
    devices: physical ? [physicalDeviceFixture("dev_p", "ready", { model: "iPhone 15 Pro" })] : [],
    downloads: { policy: "on-request" },
    health: "running",
    leases: [],
    queueDepth: 0,
  });
}

// why: the gateway's answer to a plain lease must match the worker's (ADR 0084 §3), so the cases run through the coordinator, which routes with `assess` and `select`.
describe("FleetLeaseCoordinator with phones-only workers (ADR 0084 §3)", () => {
  const PLAIN = { model: "iPhone 17", platform: "ios" as const };
  const PHYSICAL = { physical: true as const, platform: "ios" as const };

  it.each([
    {
      name: "one phones-only worker: the phones-only refusal",
      refused:
        "Every worker with ios serves only enrolled physical ios devices " +
        "(ios.virtualDevices is false); ask for a physical device (--physical, or physical: true)",
      request: PLAIN,
      workers: [["wrk_a", PHONES_ONLY("ios")]] as const,
    },
    {
      name: "a worker without the platform beside a phones-only one: still the phones-only refusal",
      refused:
        "Every worker with android serves only enrolled physical android devices " +
        "(android.virtualDevices is false); ask for a physical device (--physical, or physical: true)",
      request: { model: "Pixel 9", platform: "android" as const },
      workers: [
        ["wrk_a", EMULATORS("ios")],
        ["wrk_b", PHONES_ONLY("android")],
      ] as const,
    },
    {
      name: "a phones-only worker and an emulator worker: the emulator worker",
      request: { model: "Pixel 9", platform: "android" as const },
      served: "wrk_b",
      workers: [
        ["wrk_a", PHONES_ONLY("android")],
        ["wrk_b", EMULATORS("android")],
      ] as const,
    },
    {
      name: "a phones-only worker and a worker without the field: the second",
      request: PLAIN,
      served: "wrk_b",
      workers: [
        ["wrk_a", PHONES_ONLY("ios")],
        ["wrk_b", EMULATORS("ios")],
      ] as const,
    },
    {
      name: "one worker without the field and no models: the generic UNKNOWN_MODEL",
      refused: "Unknown ios model: iPhone 17",
      request: PLAIN,
      workers: [["wrk_a", { models: [], platform: "ios", runtimes: [] } satisfies Entry]] as const,
    },
    {
      name: "--physical to the phones-only worker: granted",
      request: PHYSICAL,
      served: "wrk_a",
      workers: [["wrk_a", PHONES_ONLY("ios")]] as const,
    },
  ])("through a gateway, $name", async ({ request, workers, ...expected }) => {
    const fleet = buildFleet();
    for (const [id, entry] of workers) {
      const client = new ScriptedWorkerClient();
      client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      fleet.directory.add(id, client);
      connect(fleet.workers, id, entry, "physical" in request);
    }

    const outcome = fleet.coordinator.request(request, requestOptions({ noWait: true }));

    if ("refused" in expected) {
      await expect(outcome).rejects.toMatchObject({
        code: "UNKNOWN_MODEL",
        message: expected.refused,
      });
    } else {
      expect((await outcome).lease.worker?.id).toBe(expected.served);
    }
  });
});
