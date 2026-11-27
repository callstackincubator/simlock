// For delivery-metrics.mjs: when the computer slept, so every duration counts awake time only.
//
// `recordedSleep(file)` reads `pmset -g log` and merges it into `file`, because the log rotates
// after about a week: what an earlier run saw before the log's first line is kept. Before the
// record starts, sleep comes from the lines clock.mjs wrote into transcripts ("The computer
// slept N min"), which see about three quarters of it. `awakeClock(rows, record)` gives
// `awake(a, b)`, the awake milliseconds between two times, and `busy(intervals, a, b)`, the
// awake milliseconds of [a, b] that at least one interval covers. `overlap(intervals, a, b)` is
// the milliseconds of [a, b] that sorted, merged intervals cover.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MIN = 60_000;
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\S+(?: \S+)?)\s/;

export function recordedSleep(file) {
  const kept = readJson(file) ?? { from: null, to: null, intervals: [] };
  let log;
  try {
    log = execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 1 << 29 });
  } catch {
    return kept;
  }
  const record = mergedRecord(kept, sleepFromLog(log));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
  return record;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function sleepFromLog(log) {
  const events = log.split("\n").map(logEvent).filter(Boolean);
  const intervals = [];
  let asleepSince = null;
  for (const { t, kind } of events) {
    if (kind === "Sleep") asleepSince ??= t;
    else if (asleepSince !== null && (kind === "Wake" || kind === "DarkWake")) {
      intervals.push([asleepSince, t]);
      asleepSince = null;
    }
  }
  return { from: events[0]?.t ?? null, to: events.at(-1)?.t ?? null, intervals };
}

function logEvent(line) {
  const m = LOG_LINE.exec(line);
  if (m === null) return null;
  return { t: Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`), kind: m[5].trim() };
}

export function mergedRecord(kept, seen) {
  if (seen.from === null) return kept;
  const older = kept.intervals.filter((iv) => iv[1] <= seen.from);
  const joins = kept.from !== null && kept.to !== null && kept.to >= seen.from;
  return {
    from: joins ? Math.min(kept.from, seen.from) : seen.from,
    to: seen.to,
    intervals: mergeIntervals([...older, ...seen.intervals]),
  };
}

export function mergeIntervals(list) {
  const sorted = list.filter((iv) => iv[1] > iv[0]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of sorted) {
    const last = merged.at(-1);
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

export function overlap(intervals, a, b) {
  let total = 0;
  for (const iv of intervals) {
    if (iv[0] >= b) break;
    total += Math.max(0, Math.min(b, iv[1]) - Math.max(a, iv[0]));
  }
  return total;
}

export function awakeClock(rows, record) {
  // why: a clock line says `min` minutes of sleep ended shortly before the line's time.
  const lines = rows.flatMap((r) =>
    r.sleeps.map((s) => [s.t - s.min * MIN - 30_000, s.t - 30_000]),
  );
  const beforeRecord = mergeIntervals(lines).filter(
    (iv) => record.from === null || iv[1] <= record.from,
  );
  const asleep = mergeIntervals([...beforeRecord, ...record.intervals]);
  const awake = (a, b) => Math.max(0, b - a - overlap(asleep, a, b));
  return { awake, busy: (intervals, a, b) => busyMs(awake, intervals, a, b), asleep };
}

function busyMs(awake, intervals, a, b) {
  return clipped(intervals, a, b).reduce((total, iv) => total + awake(iv[0], iv[1]), 0);
}

export function clipped(intervals, a, b) {
  return mergeIntervals(intervals.map((iv) => [Math.max(a, iv[0]), Math.min(b, iv[1])]));
}
