import { EventBus } from "../bus/index.js";
import type { LeaseRecord } from "../admin/index.js";
import type { MaxPerRequester } from "../core/index.js";
import { FakeClock, type Logger } from "../ports/index.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { createRoutingPolicy, type RoutingPolicy } from "./routing.js";
import {
  catalogFixture,
  deviceFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

export const GATEWAY_PREFIX = "gw:instance-1:";

class FakeDirectory implements WorkerDirectory {
  readonly clients = new Map<string, ScriptedWorkerClient>();
  readonly unreachable = new Set<string>();
  /** why: C1 (round 2 review): a worker id in here answers `reachable: true` but `client()`
   * `undefined` -- the real window `WorkerLink#reachable`/`#client` can disagree in, between a
   * reconnecting link's `#closed` clearing and its own handshake finishing (`#client` is not
   * assigned until `start()` completes). Distinct from `unreachable` above, which models
   * `reachable: false` instead -- a different code path in `#attempt`/`#forwardToWorker` that no
   * test previously exercised the *first* of the two ways. */
  readonly reachableButNoClient = new Set<string>();
  readonly refreshCalls: string[] = [];
  readonly catalogRefreshCalls: string[] = [];
  readonly failingRefresh = new Set<string>();

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    const reachable = !this.unreachable.has(workerId);
    const hasClient = reachable && !this.reachableButNoClient.has(workerId);
    return {
      client: () => (hasClient ? client.asClient() : undefined),
      reachable,
      refresh: async (options) => {
        this.refreshCalls.push(workerId);
        if (options?.includeCatalog === true) this.catalogRefreshCalls.push(workerId);
        if (this.failingRefresh.has(workerId)) throw new Error("refresh failed");
      },
      workerId,
    };
  }
}

export class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

export function harness(
  overrides: {
    readonly execTimeoutMs?: number;
    readonly leaseRequestTimeoutMs?: number;
    readonly logger?: Logger;
    readonly maxPerRequester?: MaxPerRequester;
    readonly routing?: (workers: WorkerRegistry) => RoutingPolicy;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    leaseMaxTtlMs: 4 * 60 * 60_000,
    retentionMs: 24 * 60 * 60_000,
  });
  const directory = new FakeDirectory();
  const leaseIndex = new FleetLeaseIndex(GATEWAY_PREFIX);
  const coordinator = new FleetLeaseCoordinator({
    clock,
    directory,
    describeFailure: (error) => ({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }),
    leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
    eventBus,
    execTimeoutMs: overrides.execTimeoutMs ?? 11 * 60_000,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    leaseRequestTimeoutMs: overrides.leaseRequestTimeoutMs ?? 5 * 60_000,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    ...(overrides.maxPerRequester === undefined
      ? {}
      : { maxPerRequester: overrides.maxPerRequester }),
    routing: overrides.routing?.(workers) ?? createRoutingPolicy("warm-then-free"),
    views: workers,
  });
  return { clock, coordinator, directory, eventBus, leaseIndex, workers };
}

export function connectWorker(
  workers: WorkerRegistry,
  workerId: string,
  overrides: {
    readonly label?: string;
    readonly models?: readonly string[];
    readonly platform?: "ios" | "android";
    readonly capacity?: ReturnType<typeof statusFixture>["capacity"];
    readonly devices?: ReturnType<typeof deviceFixture>[];
    readonly leases?: LeaseRecord[];
    readonly queueDepth?: number;
  } = {},
): void {
  workers.connected(workerId, overrides.label, "0.3.0");
  workers.refresh(workerId, {
    capacity: overrides.capacity ?? statusFixture().capacity,
    catalog: catalogFixture([
      {
        models: [...(overrides.models ?? ["iPhone 17"])],
        platform: overrides.platform ?? "ios",
        runtimes: ["26.0"],
      },
    ]).platforms,
    devices: overrides.devices ?? [],
    downloads: { policy: "on-request" },
    health: "running",
    leases: overrides.leases ?? [],
    queueDepth: overrides.queueDepth ?? 0,
  });
}

export async function tick(times = 16): Promise<void> {
  for (let iteration = 0; iteration < times; iteration += 1) await Promise.resolve();
}

export const REQUEST = {
  physical: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

export function saturatedIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 0 } };
}

export function roomierIos(): ReturnType<typeof statusFixture>["capacity"] {
  const capacity = statusFixture().capacity;
  return { ...capacity, ios: { ...capacity.ios, maxRunning: 3 } };
}

export function requestOptions(
  overrides: Partial<Parameters<FleetLeaseCoordinator["request"]>[1]> = {},
) {
  return {
    allowDownload: false,
    noWait: false,
    ownerId: "agent-1",
    requesterId: "agent-1",
    ...overrides,
  };
}
