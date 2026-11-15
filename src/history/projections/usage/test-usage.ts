import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus, type EventMap, type EventName } from "../../../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  NodeFilesystem,
  NodeSqliteOpener,
} from "../../../ports/index.js";
import {
  createEventHistory,
  HISTORY_DB_NAME,
  type HistoryProjectionDefinition,
  type EventHistoryHandle,
} from "../../index.js";
import {
  type MinuteBucket,
  openUsageReads,
  type RequestRow,
  USAGE_PROJECTION,
  type UsageReads,
  type UsageValue,
} from "./index.js";

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = 1_760_605_920_000;
export const ALL = Number.MAX_SAFE_INTEGER;
export const directories: string[] = [];

export interface RigOptions {
  readonly directory?: string;
  readonly at?: number;
  readonly fleet?: boolean;
  readonly eventRetention?: number;
  readonly metricsRetention?: number;
  readonly projections?: readonly HistoryProjectionDefinition[];
  readonly start?: boolean;
}

export interface Rig {
  readonly directory: string;
  readonly path: string;
  readonly clock: FakeClock;
  readonly bus: EventBus;
  readonly logs: MemoryLogSink;
  readonly history: EventHistoryHandle;
  at(timestamp: number): void;
  emit<Event extends EventName>(event: Event, payload: EventMap[Event]): void;
  relay(workerId: string, event: string, payload: Record<string, unknown>, at?: number): void;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  let directory = options.directory;
  if (directory === undefined) {
    directory = await mkdtemp(join(tmpdir(), "simlock-usage-"));
    directories.push(directory);
  }
  const clock = new FakeClock(options.at ?? T0);
  let nextId = 0;
  const bus = new EventBus(clock, 10_000, undefined, {
    generate: () => `${options.at ?? T0}_${(nextId += 1)}`,
  });
  const logs = new MemoryLogSink();
  const history = createEventHistory({
    bus,
    clock,
    config: { maxBytes: 256 * 1024 * 1024, retention: options.eventRetention ?? 7 * DAY },
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    logger: new JsonLinesLogger({ clock, sink: logs }),
    projectionOptions: {
      fleet: options.fleet ?? false,
      metricsRetentionMs: options.metricsRetention ?? 90 * DAY,
    },
    projections: options.projections ?? [USAGE_PROJECTION],
    sqlite: new NodeSqliteOpener(),
  });
  if (options.start !== false) await history.start();
  let relayed = 0;
  return {
    at: (timestamp) => clock.advance(timestamp - clock.now()),
    bus,
    clock,
    directory,
    emit: (event, payload) => {
      bus.emit(event, payload, "test");
    },
    history,
    logs,
    path: join(directory, HISTORY_DB_NAME),
    relay: (workerId, event, payload, at) => {
      relayed += 1;
      bus.republish({
        event: event as EventName,
        id: `evt_relay_${options.at ?? T0}_${relayed}`,
        module: "gateway",
        payload: { ...payload, workerId } as never,
        timestamp: at ?? clock.now(),
      });
    },
  };
}

export async function readWith<T>(
  rigged: { readonly path: string },
  read: (reads: UsageReads) => T,
) {
  const database = await new NodeSqliteOpener().open(rigged.path, { readOnly: true });
  try {
    return read(openUsageReads(database));
  } finally {
    database.close();
  }
}

export async function count(rigged: { readonly path: string }, sql: string): Promise<number> {
  const database = await new NodeSqliteOpener().open(rigged.path, { readOnly: true });
  try {
    return Number(database.prepare(sql).get()?.n);
  } finally {
    database.close();
  }
}

export async function execOn(path: string, ...statements: string[]): Promise<void> {
  const database = await new NodeSqliteOpener().open(path, { readOnly: false });
  try {
    for (const statement of statements) database.exec(statement);
  } finally {
    database.close();
  }
}

export const rowsOf = (rigged: Rig) =>
  readWith(rigged, (reads) => reads.requestRows({ from: 0, to: ALL }));
export const factsOf = (rigged: Rig) =>
  readWith(rigged, (reads) => reads.deviceFacts({ from: 0, to: ALL }));
export const buckets = (
  rigged: Rig,
  query: {
    readonly from: number;
    readonly to: number;
    readonly platform: string;
    readonly workerId?: string;
    readonly bucketMs?: number;
  },
) => readWith(rigged, (reads) => reads.minuteBuckets({ bucketMs: MIN, workerId: "", ...query }));

export function row(rows: readonly RequestRow[], requestId: string): RequestRow {
  const found = rows.find((candidate) => candidate.requestId === requestId);
  if (found === undefined) throw new Error(`no request row for ${requestId}`);
  return found;
}

export const requested = (requestId: string, over: Partial<EventMap["lease.requested"]> = {}) => ({
  requestId,
  requestSpec: { model: "iPhone 16", platform: "ios" },
  requester: "alice",
  waitPolicy: "wait",
  ...over,
});
export const granted = (
  leaseId: string,
  requestId: string,
  over: Partial<EventMap["lease.granted"]> = {},
): EventMap["lease.granted"] => ({
  deviceId: `dev-${leaseId}`,
  leaseId,
  platform: "ios",
  requestId,
  requester: "alice",
  source: "warm",
  ...over,
});
export const released = (
  leaseId: string,
  reason: "explicit" | "killed" | "device-lost" = "explicit",
) => ({
  deviceId: `dev-${leaseId}`,
  leaseId,
  ownerId: "alice",
  reason,
});
export const rejected = (
  requestId: string,
  reason: EventMap["lease.rejected"]["reason"],
  over: Partial<EventMap["lease.rejected"]> = {},
): EventMap["lease.rejected"] => ({
  reason,
  requestId,
  requestSpec: { platform: "ios" },
  requester: "alice",
  ...over,
});
export const figures = (running: number, reserved: number, maxRunning: number) => ({
  maxRunning,
  reserved,
  running,
  warm: 0,
});
export const capacity = (input: {
  readonly ios?: readonly [number, number, number];
  readonly android?: readonly [number, number, number];
  readonly global?: readonly [number, number, number];
  readonly ram?: readonly [number, number];
}): EventMap["capacity.changed"] => ({
  android: figures(...(input.android ?? [0, 0, 4])),
  global: figures(...(input.global ?? [0, 0, 8])),
  ios: figures(...(input.ios ?? [0, 0, 4])),
  ...(input.ram === undefined
    ? {}
    : { ramBudget: { limitBytes: input.ram[1], usedBytes: input.ram[0] } }),
});

export function figure(bucket: MinuteBucket | undefined, name: UsageValue) {
  return bucket?.[name];
}
