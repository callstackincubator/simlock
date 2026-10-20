export const EVENTS_PAGE_MAX = 500;
export const EVENTS_PAGE_DEFAULT = 100;

export interface EventsPageAsk {
  readonly before?: string | undefined;
  readonly limit?: string | undefined;
  readonly since?: string | undefined;
}

export type EventsPageAnswer =
  | { readonly page: { readonly beforeId?: string; readonly limit?: number } }
  | { readonly refused: string };

export function eventsPageQuery(ask: EventsPageAsk): EventsPageAnswer {
  return {
    page: {
      ...(ask.before === undefined ? {} : { beforeId: ask.before }),
      ...(ask.limit === undefined ? {} : { limit: Number(ask.limit) }),
    },
  };
}
