import type { SqliteDatabase } from "../../../ports/index.js";
import {
  type BucketFigure,
  type DeviceFactRow,
  MINUTE_MS,
  type MinuteBucket,
  type RequestRow,
  USAGE_VALUES,
  type UsageReads,
  type UsageValue,
} from "./types.js";

const REQUEST_COLUMNS = [
  "requestId",
  "requester",
  "platform",
  "model",
  "workerId",
  "requestedAt",
  "grantedAt",
  "rejectedAt",
  "reason",
  "source",
  "leaseId",
  "workerLeaseId",
  "heldMs",
  "endedAt",
  "endReason",
  "probe",
  "declined",
  "refusedAtAdmission",
] as const;

const AGGREGATES = USAGE_VALUES.map(
  (value) => `MAX(${value}Peak) AS ${value}Peak, SUM(${value}Integral) AS ${value}Integral`,
).join(", ");
const LASTS = USAGE_VALUES.map((value) => `${value}Last`).join(", ");

interface Accumulator {
  knownMs: number;
  readonly figures: Map<UsageValue, { peak: number; integral: number }>;
}

function present<Row extends object>(row: Record<string, unknown>, names: readonly string[]): Row {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const value = row[name];
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out as Row;
}

function toRequestRow(row: Record<string, unknown>): RequestRow {
  const { declined, probe, refusedAtAdmission, ...rest } = present<Record<string, unknown>>(
    row,
    REQUEST_COLUMNS,
  );
  return {
    ...rest,
    probe: probe === 1,
    ...(declined === 1 ? { declined: true } : {}),
    ...(refusedAtAdmission === 1 ? { refusedAtAdmission: true } : {}),
  } as RequestRow;
}

function add(
  buckets: Map<number, Accumulator>,
  index: number,
  knownMs: number,
  figure: (value: UsageValue) => { peak: number; integral: number } | undefined,
): void {
  let bucket = buckets.get(index);
  if (bucket === undefined) {
    bucket = { figures: new Map(), knownMs: 0 };
    buckets.set(index, bucket);
  }
  bucket.knownMs += knownMs;
  for (const value of USAGE_VALUES) {
    const added = figure(value);
    if (added === undefined) continue;
    const existing = bucket.figures.get(value);
    bucket.figures.set(
      value,
      existing === undefined
        ? added
        : {
            integral: existing.integral + added.integral,
            peak: Math.max(existing.peak, added.peak),
          },
    );
  }
}

export function openUsageReads(database: SqliteDatabase): UsageReads {
  return {
    deviceFacts: ({ from, to }) =>
      database
        .prepare(
          `SELECT at, kind, durationMs, platform, workerId, deviceId FROM device_fact_rows
           WHERE at >= ? AND at < ? ORDER BY at, id`,
        )
        .all(from, to)
        .map((row) =>
          present<DeviceFactRow>(row, [
            "at",
            "kind",
            "durationMs",
            "platform",
            "workerId",
            "deviceId",
          ]),
        ),
    minuteBuckets: (query) => minuteBuckets(database, query),
    oldestTs: () => {
      const oldest = database
        .prepare(
          `SELECT MIN(earliest) AS oldest FROM (
             SELECT MIN(requestedAt) AS earliest FROM request_rows
             UNION ALL SELECT MIN(minute) FROM minute_rows
             UNION ALL SELECT MIN(at) FROM device_fact_rows)`,
        )
        .get()?.oldest;
      return typeof oldest === "number" ? oldest : undefined;
    },
    requestRows: ({ from, to }) =>
      database
        .prepare(
          `SELECT ${REQUEST_COLUMNS.join(", ")} FROM request_rows
           WHERE requestedAt >= ? AND requestedAt < ? ORDER BY requestedAt, requestId`,
        )
        .all(from, to)
        .map(toRequestRow),
  };
}

function addCarried(
  buckets: Map<number, Accumulator>,
  span: Readonly<Record<string, unknown>>,
  window: {
    readonly bucketMs: number;
    readonly firstMinute: number;
    readonly from: number;
    readonly to: number;
  },
): void {
  const { bucketMs, firstMinute, from, to } = window;
  const start = Math.max(Number(span.minute) + MINUTE_MS, firstMinute);
  const end = Math.min(
    typeof span.next === "number" ? span.next : Number.POSITIVE_INFINITY,
    to,
    typeof span.carryUntil === "number"
      ? Math.floor(span.carryUntil / MINUTE_MS) * MINUTE_MS
      : Number.POSITIVE_INFINITY,
  );
  if (start >= end) return;
  const lasts = (value: UsageValue): number | undefined => {
    const last = span[`${value}Last`];
    return typeof last === "number" ? last : undefined;
  };
  for (
    let index = Math.floor((start - from) / bucketMs);
    from + index * bucketMs < end;
    index += 1
  ) {
    const first = Math.max(start, Math.ceil((from + index * bucketMs) / MINUTE_MS) * MINUTE_MS);
    const minutes = Math.ceil((Math.min(end, from + (index + 1) * bucketMs) - first) / MINUTE_MS);
    if (minutes <= 0) continue;
    add(buckets, index, minutes * MINUTE_MS, (value) => {
      const last = lasts(value);
      return last === undefined ? undefined : { integral: last * minutes * MINUTE_MS, peak: last };
    });
  }
}

function minuteBuckets(
  database: SqliteDatabase,
  query: Parameters<UsageReads["minuteBuckets"]>[0],
): MinuteBucket[] {
  const { bucketMs, from, platform, to, workerId } = query;
  const buckets = new Map<number, Accumulator>();
  const rows = database
    .prepare(
      `SELECT CAST((minute - ?) / ? AS INTEGER) AS bucket, SUM(knownMs) AS knownMs, ${AGGREGATES}
       FROM minute_rows WHERE workerId = ? AND platform = ? AND minute >= ? AND minute < ?
       GROUP BY bucket`,
    )
    .all(from, bucketMs, workerId, platform, from, to);
  for (const row of rows) {
    add(buckets, Number(row.bucket), Number(row.knownMs), (value) => {
      const peak = row[`${value}Peak`];
      return typeof peak === "number"
        ? { integral: Number(row[`${value}Integral`]), peak }
        : undefined;
    });
  }
  const before = database
    .prepare(
      "SELECT MAX(minute) AS minute FROM minute_rows WHERE workerId = ? AND platform = ? AND minute < ?",
    )
    .get(workerId, platform, from)?.minute;
  const spans = database
    .prepare(
      `SELECT minute, carryUntil, next, ${LASTS} FROM (
         SELECT minute, carryUntil, ${LASTS}, LEAD(minute) OVER (ORDER BY minute) AS next
         FROM minute_rows WHERE workerId = ? AND platform = ? AND minute >= ? AND minute < ?)
       WHERE next IS NULL OR next > minute + ?`,
    )
    .all(workerId, platform, typeof before === "number" ? before : from, to, MINUTE_MS);
  const firstMinute = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
  for (const span of spans) addCarried(buckets, span, { bucketMs, firstMinute, from, to });
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, bucket]) => ({
      knownMs: bucket.knownMs,
      start: from + index * bucketMs,
      ...Object.fromEntries(bucket.figures as Map<UsageValue, BucketFigure>),
    }));
}
