import type { Statements } from "./statements.js";
import { MINUTE_MS, minuteOf, USAGE_VALUES, type UsageValue } from "./types.js";

interface Figure {
  peak: number;
  last: number | null;
  integral: number;
}

interface MinuteRowData {
  knownMs: number;
  carryUntil: number | null;
  readonly figures: Map<UsageValue, Figure>;
}

interface Held {
  readonly level: number;
  readonly since: number;
  readonly settled: number;
  readonly settledMinute: number;
}

interface KeyState {
  readonly worker: string;
  readonly platform: string;
  known: boolean;
  lastAt: number;
  lastRowMinute: number;
  readonly values: Map<UsageValue, Held>;
}

const COLUMNS = [
  "workerId",
  "platform",
  "minute",
  "knownMs",
  "carryUntil",
  ...USAGE_VALUES.flatMap((value) => [`${value}Peak`, `${value}Last`, `${value}Integral`]),
];
const SAVE_SQL = `INSERT OR REPLACE INTO minute_rows (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const LOAD_SQL = `SELECT ${COLUMNS.join(", ")} FROM minute_rows WHERE workerId = ? AND platform = ? AND minute = ?`;
const CLOSE_KEY_SQL = `UPDATE minute_rows SET carryUntil = minute + ${MINUTE_MS}
  WHERE workerId = ? AND platform = ? AND carryUntil IS NULL AND minute = (
    SELECT MAX(later.minute) FROM minute_rows later WHERE later.workerId = ? AND later.platform = ?)`;
const OPEN_KEYS_SQL =
  "SELECT DISTINCT workerId, platform FROM minute_rows WHERE carryUntil IS NULL";

function foldFigure(
  row: MinuteRowData,
  value: UsageValue,
  step: {
    readonly level: number;
    readonly previous: number | undefined;
    readonly rest: number;
    readonly settled: number;
  },
): void {
  const figure = row.figures.get(value);
  if (figure === undefined) {
    row.figures.set(value, {
      integral: step.level * step.rest,
      last: step.level,
      peak: step.level,
    });
    return;
  }
  figure.integral += (step.level - (step.previous ?? 0)) * step.rest;
  figure.peak = Math.max(step.settled, step.level);
  figure.last = step.level;
}

function heldLevel(state: KeyState, held: Held | undefined, figure: Figure | undefined) {
  return state.known ? held?.level : (figure?.last ?? undefined);
}

// why: a level replaced in the same ms it began held for no time, so it is no peak of the minute.
function settledPeak(
  figure: Figure | undefined,
  held: Held | undefined,
  minute: number,
  at: number,
): number {
  if (held === undefined) return figure?.peak ?? Number.NEGATIVE_INFINITY;
  const settled = held.settledMinute === minute ? held.settled : Number.NEGATIVE_INFINITY;
  return at - Math.max(held.since, minute) > 0 ? Math.max(settled, held.level) : settled;
}

// why: a row's integral is taken through the minute's end as if the last value held, so a reader needs no row for the minutes after; a cut takes the rest back off.
export class MinuteRecorder {
  readonly #statements: Statements;
  readonly #states = new Map<string, KeyState>();

  constructor(statements: Statements) {
    this.#statements = statements;
  }

  step(
    worker: string,
    platform: string,
    value: UsageValue,
    level: number,
    timestamp: number,
  ): void {
    const state = this.#state(worker, platform);
    if (state.known && state.values.get(value)?.level === level) return;
    // why: a worker's clock may run behind this one; a step stamped before the key's last counts there.
    const at = Math.max(timestamp, state.lastAt);
    const minute = minuteOf(at);
    const end = minute + MINUTE_MS;
    const row = this.#rowFor(state, minute, at);
    const figure = row.figures.get(value);
    const held = state.known ? state.values.get(value) : undefined;
    const previous = heldLevel(state, held, figure);
    const settled = settledPeak(figure, held, minute, at);
    foldFigure(row, value, { level, previous, rest: end - at, settled });
    row.carryUntil = null;
    this.#save(worker, platform, minute, row);
    state.known = true;
    state.values.set(value, { level, settled, settledMinute: minute, since: at });
    state.lastAt = at;
    state.lastRowMinute = minute;
  }

  #rowFor(state: KeyState, minute: number, at: number): MinuteRowData {
    const end = minute + MINUTE_MS;
    const stored = this.#load(state.worker, state.platform, minute);
    if (stored === undefined) {
      const row: MinuteRowData = {
        carryUntil: null,
        figures: new Map(),
        knownMs: state.known ? MINUTE_MS : end - at,
      };
      if (state.known) carryInto(row, state);
      return row;
    }
    if (!state.known && stored.carryUntil !== null) {
      stored.knownMs = Math.min(MINUTE_MS, stored.knownMs + end - at);
    }
    return stored;
  }

  cut(worker: string | undefined, timestamp: number): void {
    for (const state of this.#states.values()) {
      if (state.known && (worker === undefined || state.worker === worker)) {
        this.#end(state, timestamp);
      }
    }
  }

  // why: a key this run has stepped had its open row closed when its first step came, so only the keys left are closed here.
  closeOpenRows(): void {
    for (const open of this.#statements.get(OPEN_KEYS_SQL).all()) {
      const worker = String(open.workerId);
      const platform = String(open.platform);
      if (!this.#states.has(keyOf(worker, platform))) this.#closeKey(worker, platform);
    }
  }

  #closeKey(worker: string, platform: string): void {
    this.#statements.get(CLOSE_KEY_SQL).run(worker, platform, worker, platform);
  }

  forget(): void {
    this.#states.clear();
  }

  #end(state: KeyState, timestamp: number): void {
    const at = Math.max(timestamp, state.lastAt);
    const minute = minuteOf(at);
    let row = this.#load(state.worker, state.platform, minute);
    if (row === undefined && at > minute) {
      row = { carryUntil: null, figures: new Map(), knownMs: MINUTE_MS };
      carryInto(row, state);
    }
    if (row !== undefined) {
      const tail = minute + MINUTE_MS - at;
      row.knownMs = Math.max(0, row.knownMs - tail);
      for (const figure of row.figures.values()) {
        if (figure.last !== null) figure.integral -= figure.last * tail;
        figure.last = null;
      }
      row.carryUntil = at;
      this.#save(state.worker, state.platform, minute, row);
    } else {
      const lastRow = this.#load(state.worker, state.platform, state.lastRowMinute);
      if (lastRow !== undefined) {
        lastRow.carryUntil = at;
        this.#save(state.worker, state.platform, state.lastRowMinute, lastRow);
      }
    }
    state.known = false;
    state.values.clear();
    state.lastAt = at;
  }

  #state(worker: string, platform: string): KeyState {
    const key = keyOf(worker, platform);
    let state = this.#states.get(key);
    if (state === undefined) {
      // why: a row left open by an earlier run is closed before this run writes a newer one for the key, so its value is not carried over the downtime.
      this.#closeKey(worker, platform);
      state = { known: false, lastAt: 0, lastRowMinute: 0, platform, values: new Map(), worker };
      this.#states.set(key, state);
    }
    return state;
  }

  #load(worker: string, platform: string, minute: number): MinuteRowData | undefined {
    const stored = this.#statements.get(LOAD_SQL).get(worker, platform, minute);
    if (stored === undefined) return undefined;
    const figures = new Map<UsageValue, Figure>();
    for (const value of USAGE_VALUES) {
      const peak = stored[`${value}Peak`];
      if (typeof peak !== "number") continue;
      const last = stored[`${value}Last`];
      figures.set(value, {
        integral: Number(stored[`${value}Integral`]),
        last: typeof last === "number" ? last : null,
        peak,
      });
    }
    const carryUntil = stored.carryUntil;
    return {
      carryUntil: typeof carryUntil === "number" ? carryUntil : null,
      figures,
      knownMs: Number(stored.knownMs),
    };
  }

  #save(worker: string, platform: string, minute: number, row: MinuteRowData): void {
    this.#statements.get(SAVE_SQL).run(
      worker,
      platform,
      minute,
      row.knownMs,
      row.carryUntil,
      ...USAGE_VALUES.flatMap((value) => {
        const figure = row.figures.get(value);
        return figure === undefined
          ? [null, null, null]
          : [figure.peak, figure.last, figure.integral];
      }),
    );
  }
}

function keyOf(worker: string, platform: string): string {
  return `${worker}\u0000${platform}`;
}

function carryInto(row: MinuteRowData, state: KeyState): void {
  for (const [name, { level }] of state.values) {
    row.figures.set(name, { integral: level * MINUTE_MS, last: level, peak: level });
  }
}
