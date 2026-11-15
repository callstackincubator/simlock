import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  NodeFilesystem,
  NodeSqliteOpener,
  type SqliteOpener,
} from "../ports/index.js";
import {
  createEventHistory,
  HISTORY_DB_NAME,
  type HistoryProjectionDefinition,
  openHistoryReader,
} from "./index.js";
import { plainProjection } from "./testing.js";

export const NOW = 1_760_605_920_000;
export const HOUR = 3_600_000;
export const JUNK = "this is not a sqlite database ".repeat(20);
export const directories: string[] = [];

export class RecordingFilesystem extends NodeFilesystem {
  readonly renames: Array<{ readonly from: string; readonly to: string }> = [];
  beforeRename: (() => Promise<void>) | undefined;

  override async rename(from: string, to: string): Promise<void> {
    this.renames.push({ from, to });
    await this.beforeRename?.();
    await super.rename(from, to);
  }
}

export interface Rig {
  readonly directory: string;
  readonly dbPath: string;
  readonly clock: FakeClock;
  readonly bus: EventBus;
  readonly logs: MemoryLogSink;
  readonly filesystem: RecordingFilesystem;
  readonly sqlite: SqliteOpener;
  history(options?: {
    readonly sqlite?: SqliteOpener;
    readonly retention?: number;
    readonly maxBytes?: number;
    readonly projections?: readonly HistoryProjectionDefinition[];
  }): ReturnType<typeof createEventHistory>;
}

export async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-history-"));
  directories.push(directory);
  return directory;
}

export async function rig(
  options: { readonly capacity?: number; readonly directory?: string } = {},
): Promise<Rig> {
  const directory = options.directory ?? (await dataDirectory());
  const clock = new FakeClock(NOW);
  let nextId = 0;
  const bus = new EventBus(clock, options.capacity ?? 1_000, undefined, {
    generate: () => String((nextId += 1)).padStart(6, "0"),
  });
  const logs = new MemoryLogSink();
  const filesystem = new RecordingFilesystem();
  const sqlite = new NodeSqliteOpener();
  return {
    bus,
    clock,
    dbPath: join(directory, HISTORY_DB_NAME),
    directory,
    filesystem,
    history: (overrides = {}) =>
      createEventHistory({
        bus,
        clock,
        config: {
          maxBytes: overrides.maxBytes ?? 256 * 1024 * 1024,
          retention: overrides.retention ?? 7 * 24 * HOUR,
        },
        dataDirectory: directory,
        filesystem,
        logger: new JsonLinesLogger({ clock, sink: logs }),
        projectionOptions: { fleet: false, metricsRetentionMs: 90 * 24 * HOUR },
        projections: overrides.projections ?? [],
        sqlite: overrides.sqlite ?? sqlite,
      }),
    logs,
    sqlite,
  };
}

export function stopping(bus: EventBus, reason: string): EventEnvelope {
  return bus.emit("daemon.stopping", { reason }, "daemon");
}

export function relayed(bus: EventBus, id: string, timestamp: number): EventEnvelope {
  return bus.republish({
    event: "daemon.stopping",
    id,
    module: "daemon",
    payload: { reason: id },
    timestamp,
  });
}

export function levelRecords(rigged: Rig, level: string): number {
  return rigged.logs.records.filter((record) => record.level === level).length;
}

export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function recordingProjection(): {
  readonly definition: HistoryProjectionDefinition;
  readonly applied: string[];
  readonly pruned: number[];
} {
  const applied: string[] = [];
  const pruned: number[] = [];
  return {
    applied,
    definition: plainProjection("recording", () => ({
      apply: (envelope) => {
        applied.push(envelope.id);
      },
      prune: (now) => {
        pruned.push(now);
      },
    })),
    pruned,
  };
}

export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function damagedNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".damaged-"));
}

export async function readHistoryOf(directory: string): Promise<EventEnvelope[]> {
  return openHistoryReader({
    dataDirectory: directory,
    filesystem: new NodeFilesystem(),
    sqlite: new NodeSqliteOpener(),
  }).read({ sinceTs: 0 });
}

export async function countRows(path: string, table: string): Promise<number> {
  const database = await new NodeSqliteOpener().open(path, { readOnly: true });
  try {
    return Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  } finally {
    database.close();
  }
}

export const INSERTS_EVENT = /INSERT\s+(OR\s+IGNORE\s+)?INTO\s+events/i;
