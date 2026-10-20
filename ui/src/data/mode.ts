import type { ApiClient } from "./api";
import type { LiveConnection } from "./live/connection";

export type DaemonMode = "gateway" | "worker";

export interface ModeStore {
  readonly mode: () => DaemonMode | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

export function watchMode(_options: {
  readonly api: Pick<ApiClient, "get">;
  readonly connection: Pick<LiveConnection, "onStreamOpened">;
}): ModeStore {
  return { mode: () => undefined, subscribe: () => () => {} };
}
