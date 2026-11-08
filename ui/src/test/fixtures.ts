import type { WorkerView } from "../model/workers";

// why: the time every page of a DOM test sees; `renderConsole` fixes `Date` to it.
export const NOW = Date.parse("2026-10-02T12:00:00.000Z");

const capacityEntry = { maxRunning: 6, overLimit: false, reserved: 0, running: 0 };
const platformCapacity = { ...capacityEntry, atRamBudget: false, limit: 6, used: 0, warm: 0 };

export function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capabilities: [],
    capacity: {
      android: { ...platformCapacity, limit: 0, maxRunning: 0 },
      global: { ...capacityEntry, warm: 0 },
      ios: platformCapacity,
    },
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id: "wrk_1",
    label: "mac-studio-01",
    lastSeenAt: NOW - 2_000,
    leases: [],
    version: "0.6.0",
    ...overrides,
  };
}
