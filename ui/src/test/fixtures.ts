import type { BaselineEntry } from "../../../src/contract/index";
import type { ConsoleEvent } from "../model/events";
import type { InboxItem } from "../model/inbox";
import type { LeaseRecord, TokenRecord } from "../model/leases";
import type { WaitingRequest } from "../model/waiting";
import type { WorkerDevice, WorkerView } from "../model/workers";

// why: every builder returns the contract's own type, so a field the contract renames or requires
// fails the type check here instead of leaving a test asserting on a shape the daemon no longer
// sends.
// why: the time every page of a DOM test sees; `renderConsole` fixes `Date` to it.
export const NOW = Date.parse("2026-10-02T12:00:00.000Z");

const capacityEntry = { maxRunning: 6, overLimit: false, reserved: 0, running: 0 };
const platformCapacity = { ...capacityEntry, atRamBudget: false, limit: 6, used: 0, warm: 0 };

export function device(overrides: Partial<WorkerDevice> = {}): WorkerDevice {
  return {
    id: "dev_1",
    physical: false,
    servesDefaultMode: true,
    spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
    state: "ready",
    ...overrides,
  } as WorkerDevice;
}

export function lease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    deviceId: "dev_1",
    grantedAt: NOW - 3_600_000,
    id: "lse_1",
    idChosenByRequester: false,
    lastRenewedAt: NOW - 60_000,
    ownerId: "tok_agent",
    requesterId: "agent-a",
    ttlDeadline: NOW + 600_000,
    ttlMs: 900_000,
    ...overrides,
  };
}

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

export function request(overrides: Partial<WaitingRequest> = {}): WaitingRequest {
  return {
    createdAt: NOW - 75_000,
    id: "req_1",
    queuePosition: 1,
    requesterId: "agent-b",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
    ...overrides,
  } as WaitingRequest;
}

export function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return { createdAt: NOW - 86_400_000, id: "tok_agent", role: "agent", ...overrides };
}

export function baseline(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mode: "full",
    model: "iPhone 16",
    name: "ios-18.4-iphone16",
    osVersion: "18.4",
    platform: "ios",
    savedAt: new Date(NOW - 3_600_000).toISOString(),
    sizeBytes: 3 * 2 ** 30,
    version: 1,
    ...overrides,
  };
}

let seq = 0;
export function event(name: string, payload: unknown = {}, overrides = {}): ConsoleEvent {
  seq += 1;
  return {
    event: name,
    id: `evt_${String(seq)}`,
    payload,
    seq,
    timestamp: NOW,
    ...overrides,
  };
}

// why: an Inbox item is the daemon's answer, so a test names the condition it wants and the worker
// it is about.
export function workerItem(
  condition: string,
  group: "Broken" | "Needs a look",
  w: WorkerView = worker(),
): InboxItem {
  return { condition, group, key: `${w.id}/${condition}`, worker: w } as InboxItem;
}
