import { parseDurationMs } from "./duration.js";

export interface UsageWindowAsk {
  readonly since?: string;
  readonly from?: string;
  readonly to?: string;
}

export type UsageWindowRefusal =
  | { readonly parameter: "from"; readonly problem: "since-and-from" }
  | { readonly parameter: "to"; readonly problem: "to-without-from" }
  | { readonly parameter: "from"; readonly problem: "not-before-to" }
  | { readonly parameter: "since"; readonly problem: "bad-duration"; readonly value: string }
  | {
      readonly parameter: "from" | "to";
      readonly problem: "bad-time";
      readonly value: string;
    };

export type UsageWindowAnswer =
  | { readonly window: { readonly from: number; readonly to: number } }
  | { readonly refused: UsageWindowRefusal };

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTime(value: string): number | undefined {
  if (!ISO_TIME.test(value)) return undefined;
  // why: `Date.parse` rolls 31 February over to March and reads `T24:00` as the next midnight; a typo must not ask for another window.
  const [year, month, day, hour] = value.split(/[-T:]/, 4).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0);
  if (hour > 23 || day > lastDay.getUTCDate()) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

export function usageWindow(ask: UsageWindowAsk, now: number): UsageWindowAnswer {
  if (ask.since !== undefined && ask.from !== undefined) {
    return { refused: { parameter: "from", problem: "since-and-from" } };
  }
  if (ask.to !== undefined && ask.from === undefined) {
    return { refused: { parameter: "to", problem: "to-without-from" } };
  }
  if (ask.from === undefined) {
    const span = ask.since === undefined ? DAY_MS : parseDurationMs(ask.since);
    if (span === undefined) {
      return {
        refused: { parameter: "since", problem: "bad-duration", value: ask.since as string },
      };
    }
    return { window: { from: now - span, to: now } };
  }
  const from = parseTime(ask.from);
  if (from === undefined) {
    return { refused: { parameter: "from", problem: "bad-time", value: ask.from } };
  }
  const to = ask.to === undefined ? now : parseTime(ask.to);
  if (to === undefined) {
    return { refused: { parameter: "to", problem: "bad-time", value: ask.to as string } };
  }
  return from < to
    ? { window: { from, to } }
    : { refused: { parameter: "from", problem: "not-before-to" } };
}
