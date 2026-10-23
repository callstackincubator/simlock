import type { ApiPath } from "./api";
import type { Clock, LiveConnection, ResourceState } from "./live/connection";
import type { ConsoleEvent } from "../model/events";

export interface RecentFeed {
  readonly acquire: () => () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ResourceState<readonly ConsoleEvent[]>;
}

const NOTHING: ResourceState<readonly ConsoleEvent[]> = {};

export function createRecentFeed(_options: {
  readonly get: (path: ApiPath) => Promise<unknown>;
  readonly clock: Clock;
  readonly connection: LiveConnection;
}): RecentFeed {
  return {
    acquire: () => () => undefined,
    snapshot: () => NOTHING,
    subscribe: () => () => undefined,
  };
}
