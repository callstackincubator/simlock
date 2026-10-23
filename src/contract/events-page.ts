import { EVENT_ID_PATTERN } from "./schemas.js";

export const EVENTS_PAGE_MAX = 500;
export const EVENTS_PAGE_DEFAULT = 100;

export interface EventsPageAsk {
  readonly before?: string | undefined;
  readonly limit?: string | undefined;
  readonly since?: string | undefined;
  readonly worker?: string | undefined;
}

export type EventsPageAnswer =
  | {
      readonly page: {
        readonly beforeId?: string;
        readonly limit?: number;
        readonly workerId?: string;
      };
    }
  | { readonly refused: string };

const LIMIT_DIGITS = /^[1-9]\d{0,2}$/;

export const EVENTS_WORKER_MAX = 128;

export function eventsPageQuery(ask: EventsPageAsk): EventsPageAnswer {
  if (ask.worker !== undefined && (ask.worker === "" || ask.worker.length > EVENTS_WORKER_MAX)) {
    return { refused: "worker must be a worker id of 1 to 128 characters" };
  }
  if (ask.before !== undefined && !EVENT_ID_PATTERN.test(ask.before)) {
    return { refused: "before must be an event id" };
  }
  const limit = ask.limit === undefined ? undefined : parseLimit(ask.limit);
  if (ask.limit !== undefined && limit === undefined) {
    return { refused: "limit must be a whole number from 1 to 500" };
  }
  if (ask.since !== undefined && ask.before !== undefined) {
    return { refused: "before and since cannot be used together" };
  }
  if (ask.since !== undefined && limit !== undefined) {
    return { refused: "limit and since cannot be used together" };
  }
  return {
    page: {
      ...(ask.before === undefined ? {} : { beforeId: ask.before }),
      ...(limit === undefined ? {} : { limit }),
      ...(ask.worker === undefined ? {} : { workerId: ask.worker }),
    },
  };
}

function parseLimit(value: string): number | undefined {
  if (!LIMIT_DIGITS.test(value)) return undefined;
  const limit = Number(value);
  return limit <= EVENTS_PAGE_MAX ? limit : undefined;
}

export const EVENTS_PAGE_WITH_SINCE_MESSAGE = "beforeId and limit cannot be used with sinceTs";

export function eventsPageWithoutSince(input: {
  readonly beforeId?: unknown;
  readonly limit?: unknown;
  readonly sinceTs?: unknown;
}): boolean {
  return input.sinceTs === undefined || (input.beforeId === undefined && input.limit === undefined);
}
