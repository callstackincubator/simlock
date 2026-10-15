import { describe, expect, it } from "vitest";

import { platformSlots, slotsLabel, workerHealth } from "./fleet";
import type { WorkerDevice, WorkerView } from "./workers";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const GIB = 2 ** 30;

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function device(id: string, state: string, platform: "ios" | "android" = "ios"): WorkerDevice {
  return {
    id,
    mode: "full",
    physical: false,
    spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform },
    state,
  } as unknown as WorkerDevice;
}

function capacity(ios: number, android: number): NonNullable<WorkerView["capacity"]> {
  return {
    android: { limit: android, running: 0 },
    global: { limit: ios + android, running: 0, warm: 0 },
    ios: { limit: ios, running: 0 },
  } as unknown as NonNullable<WorkerView["capacity"]>;
}

function load(cpu: number, memoryUsed: number, pressure?: "normal" | "warn" | "critical") {
  return {
    cpu: { busyPercent: cpu, cores: 8, limited: false },
    disk: { freeBytes: 500 * GIB, totalBytes: 1000 * GIB },
    memory: {
      availableBytes: (1 - memoryUsed / 100) * 32 * GIB,
      limited: false,
      totalBytes: 32 * GIB,
      ...(pressure === undefined ? {} : { pressure }),
    },
    readAt: NOW,
  } as unknown as NonNullable<WorkerView["load"]>;
}

describe("a worker's health square", () => {
  it("is green and reads connected when nothing is wrong", () => {
    expect(workerHealth(worker({ load: load(40, 50) }))).toEqual({ tone: "ok", word: "connected" });
  });

  it("names the worst finding: red for a lost worker, yellow for drained or a load over its threshold", () => {
    const cases: readonly [Partial<WorkerView>, string, string][] = [
      [{ connection: "disconnected", drained: true }, "error", "disconnected"],
      [{ connection: "incompatible" }, "error", "incompatible"],
      [{ drained: true }, "warn", "drained"],
      [{ load: load(91, 40) }, "warn", "CPU 91%"],
      [{ load: load(30, 88) }, "warn", "memory 88%"],
      [{ load: load(97, 88) }, "error", "CPU 97%"],
      [{ load: load(30, 97, "warn") }, "warn", "memory pressure warn"],
      [{ load: load(30, 40, "critical") }, "error", "memory pressure critical"],
    ];
    for (const [overrides, tone, word] of cases) {
      expect(workerHealth(worker(overrides)), word).toEqual({ tone, word });
    }
  });

  it("ignores a stale load reading from a worker that is not connected", () => {
    expect(workerHealth(worker({ connection: "disconnected", load: load(99, 99) }))).toEqual({
      tone: "error",
      word: "disconnected",
    });
  });
});

describe("a worker's slots", () => {
  it("draws each running device by its state and the room left under the limit as free", () => {
    const slots = platformSlots(
      worker({
        capacity: capacity(4, 2),
        devices: [
          device("a", "leased"),
          device("b", "ready"),
          device("c", "provisioning"),
          device("d", "shutdown"),
          device("e", "quarantined", "android"),
        ],
      }),
      "ios",
    );

    expect(slots.map((slot) => slot.kind)).toEqual(["leased", "ready", "busy", "free"]);
    expect(slotsLabel(slots)).toBe("1 leased, 1 ready, 1 booting, 1 free");
  });

  it("has no free slots on a worker that is not connected", () => {
    const slots = platformSlots(
      worker({ capacity: capacity(4, 0), connection: "disconnected" }),
      "ios",
    );

    expect(slots).toEqual([]);
    expect(slotsLabel(slots)).toBe("No devices");
  });
});
