import { QueryClient, type QueryObserverOptions } from "@tanstack/react-query";

import type { ApiPath } from "../data/api";
import type { Clock, LiveConnection, Visibility } from "../data/live/connection";

export interface QueriesOptions {
  readonly connection: LiveConnection;
  readonly clock: Clock;
  readonly visibility: Visibility;
}

export interface Queries {
  readonly client: QueryClient;
  options<T>(path: ApiPath): QueryObserverOptions<T>;
  dispose(): void;
}

export function createQueries(_options: QueriesOptions): Queries {
  const client = new QueryClient();
  return {
    client,
    dispose: () => undefined,
    options: (path) => ({ queryFn: () => Promise.resolve(undefined as never), queryKey: [path] }),
  };
}
