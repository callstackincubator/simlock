import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus, type EventEnvelope, type EventMap, type EventName } from "../bus/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  type SqliteDatabase,
  type SqliteOpener,
  type SqliteStatement,
} from "../ports/index.js";
import {
  createEventHistory,
  HISTORY_DB_NAME,
  HISTORY_PROJECTIONS,
  type EventHistoryHandle,
  type EventHistoryStatus,
  type HistoryProjectionDefinition,
  openHistoryReader,
  type ProjectionHandle,
} from "./index.js";

export function plainProjection(
  name: string,
  create: (database: SqliteDatabase) => Omit<ProjectionHandle, "rebuild">,
): HistoryProjectionDefinition {
  return {
    check: () => true,
    create: (database) => ({ rebuild: () => undefined, ...create(database) }),
    migrations: [],
    name,
    version: 0,
  };
}

export function readHistoryEvents(dataDirectory: string, sinceTs = 0): Promise<EventEnvelope[]> {
  return openHistoryReader({
    dataDirectory,
    filesystem: new NodeFilesystem(),
    sqlite: new NodeSqliteOpener(),
  }).read({ sinceTs });
}

export interface ProbeConnection {
  readonly path: string;
  readonly database: SqliteDatabase;
  readonly readOnly: boolean;
  closed: boolean;
}

export type ProbeCall =
  | { readonly kind: "open"; readonly path: string; readonly connection: number }
  | { readonly kind: "exec" | "prepare"; readonly sql: string; readonly connection: number };

export interface ProbeOptions {
  readonly beforeOpen?: (call: { readonly connection: number }) => Promise<void>;
  readonly fault?: (call: ProbeCall) => void;
  readonly answer?: (call: {
    readonly sql: string;
    readonly connection: number;
  }) => Record<string, unknown>[] | undefined;
}

export class ProbeSqliteOpener implements SqliteOpener {
  readonly connections: ProbeConnection[] = [];
  opens = 0;
  readonly #inner = new NodeSqliteOpener();
  readonly #options: ProbeOptions;

  constructor(options: ProbeOptions = {}) {
    this.#options = options;
  }

  async open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase> {
    const connection = this.opens;
    this.opens += 1;
    await this.#options.beforeOpen?.({ connection });
    this.#options.fault?.({ connection, kind: "open", path });
    const database = await this.#inner.open(path, options);
    const probe: ProbeConnection = { closed: false, database, path, readOnly: options.readOnly };
    this.connections.push(probe);
    return {
      close: () => {
        probe.closed = true;
        database.close();
      },
      exec: (sql) => {
        this.#options.fault?.({ connection, kind: "exec", sql });
        database.exec(sql);
      },
      prepare: (sql) => {
        this.#options.fault?.({ connection, kind: "prepare", sql });
        const answered = this.#options.answer?.({ connection, sql });
        if (answered !== undefined) return answeredStatement(answered);
        return database.prepare(sql);
      },
    };
  }
}

function answeredStatement(rows: Record<string, unknown>[]): SqliteStatement {
  return {
    all: () => rows,
    get: () => rows[0],
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  };
}

export function fixedEventHistory(status: EventHistoryStatus): EventHistoryHandle {
  return {
    replay: () => Promise.resolve([]),
    start: () => Promise.resolve(),
    status: () => status,
    stop: () => Promise.resolve(),
  };
}

export async function seedHistory(
  dataDirectory: string,
  timestamps: readonly number[],
): Promise<void> {
  const clock = new FakeClock(0);
  let nextId = 0;
  const bus = new EventBus(clock, 1_000, undefined, { generate: () => String((nextId += 1)) });
  const history = createEventHistory({
    bus,
    clock,
    config: { maxBytes: Number.MAX_SAFE_INTEGER, retention: Number.MAX_SAFE_INTEGER },
    dataDirectory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    projectionOptions: { fleet: false, metricsRetentionMs: Number.MAX_SAFE_INTEGER },
    projections: [],
    sqlite: new NodeSqliteOpener(),
  });
  await history.start();
  for (const [index, timestamp] of timestamps.entries()) {
    clock.advance(timestamp - clock.now());
    bus.emit("daemon.stopping", { reason: `r${index + 1}` }, "daemon");
  }
  await history.stop();
}

export function ringEventHistory(bus: EventBus): EventHistoryHandle {
  return createEventHistory({
    bus,
    clock: new FakeClock(0),
    config: { maxBytes: Number.MAX_SAFE_INTEGER, retention: Number.MAX_SAFE_INTEGER },
    dataDirectory: "/unused",
    filesystem: new MemoryFilesystem(),
    logger: new NoopLogger(),
    projectionOptions: { fleet: false, metricsRetentionMs: Number.MAX_SAFE_INTEGER },
    projections: [],
    sqlite: new NodeSqliteOpener(),
  });
}

export interface UsageRigDeps {
  readonly historyPath: string;
  opened(): boolean;
  tokenLabels(): Promise<ReadonlyMap<string, string>>;
  workers(): readonly { readonly id: string; readonly label?: string | undefined }[];
  readonly fleet?: { readonly requesterPrefix: string };
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = 1_760_605_920_000;

const directories: string[] = [];

export async function removeUsageRigs(): Promise<void> {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
}

export interface UsageRig {
  readonly directory: string;
  readonly historyPath: string;
  readonly clock: FakeClock;
  readonly bus: EventBus;
  readonly history: EventHistoryHandle;
  at(timestamp: number): void;
  emit<Event extends EventName>(event: Event, payload: EventMap[Event]): void;
  relay(workerId: string, event: string, payload: Record<string, unknown>, at?: number): void;
  deps(overrides?: Partial<UsageRigDeps>): UsageRigDeps;
  close(): Promise<void>;
}

export interface UsageRigOptions {
  readonly fleet?: boolean;
  readonly at?: number;
  readonly eventRetention?: number;
  readonly directory?: string;
}

export async function usageRig(options: UsageRigOptions = {}): Promise<UsageRig> {
  const made = options.directory === undefined;
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), "simlock-usage-read-")));
  if (made) directories.push(directory);
  const start = options.at ?? T0;
  const clock = new FakeClock(start);
  let nextId = 0;
  const bus = new EventBus(clock, 10_000, undefined, {
    generate: () => `${start}_${(nextId += 1)}`,
  });
  const history = createEventHistory({
    bus,
    clock,
    config: { maxBytes: 256 * 1024 * 1024, retention: options.eventRetention ?? 7 * DAY },
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    projectionOptions: { fleet: options.fleet ?? false, metricsRetentionMs: 90 * DAY },
    projections: Object.values(HISTORY_PROJECTIONS),
    sqlite: new NodeSqliteOpener(),
  });
  await history.start();
  const historyPath = join(directory, HISTORY_DB_NAME);
  let relayed = 0;
  return {
    at: (timestamp) => clock.advance(timestamp - clock.now()),
    bus,
    clock,
    close: () => history.stop(),
    deps: (overrides = {}): UsageRigDeps => ({
      historyPath,
      opened: () => history.status().opened,
      tokenLabels: async () => new Map(),
      workers: () => [],
      ...(options.fleet === true ? { fleet: { requesterPrefix: "gw:gw-1:" } } : {}),
      ...overrides,
    }),
    directory,
    emit: (event, payload) => {
      bus.emit(event, payload, "test");
    },
    history,
    historyPath,
    relay: (workerId, event, payload, at) => {
      relayed += 1;
      bus.republish({
        event: event as EventName,
        id: `evt_relay_${start}_${relayed}`,
        module: "gateway",
        payload: { ...payload, workerId } as never,
        timestamp: at ?? clock.now(),
      });
    },
  };
}

export const requested = (requestId: string, over: Partial<EventMap["lease.requested"]> = {}) => ({
  requestId,
  requestSpec: { model: "iPhone 16", platform: "ios" },
  requester: "alice",
  waitPolicy: "wait" as const,
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

export const released = (leaseId: string, requester = "alice") => ({
  deviceId: `dev-${leaseId}`,
  leaseId,
  ownerId: requester,
  reason: "explicit" as const,
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

export const capacity = (input: {
  readonly ios?: readonly [number, number, number];
  readonly android?: readonly [number, number, number];
  readonly global?: readonly [number, number, number];
  readonly ram?: readonly [number, number];
}): EventMap["capacity.changed"] => {
  const figures = ([running, reserved, maxRunning]: readonly [number, number, number]) => ({
    maxRunning,
    reserved,
    running,
    warm: 0,
  });
  return {
    android: figures(input.android ?? [0, 0, 4]),
    global: figures(input.global ?? [0, 0, 8]),
    ios: figures(input.ios ?? [0, 0, 4]),
    ...(input.ram === undefined
      ? {}
      : { ramBudget: { limitBytes: input.ram[1], usedBytes: input.ram[0] } }),
  };
};
