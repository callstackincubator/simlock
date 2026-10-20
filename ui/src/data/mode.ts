import type { ApiClient } from "./api";
import type { LiveConnection } from "./live/connection";

export type DaemonMode = "gateway" | "worker";

export interface ModeStore {
  readonly mode: () => DaemonMode | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

interface StatusBody {
  readonly daemon?: { readonly mode?: unknown };
}

function modeOf(body: StatusBody): DaemonMode | undefined {
  const mode = body.daemon?.mode;
  return mode === "gateway" || mode === "worker" ? mode : undefined;
}

// why: ADR 0037 §4. The console reads `daemon.mode` from `GET /v1/status` once it is signed in and
// again after every reconnect, and nothing else from that route. A read that fails or names a mode
// this console does not know leaves none, so nothing is ever offered on a guess.
export function watchMode(options: {
  readonly api: Pick<ApiClient, "get">;
  readonly connection: Pick<LiveConnection, "onStreamOpened">;
}): ModeStore {
  const { api, connection } = options;
  const listeners = new Set<() => void>();
  let current: DaemonMode | undefined;
  const read = async () => {
    let next: DaemonMode | undefined;
    try {
      next = modeOf((await api.get<StatusBody>("/v1/status")).body);
    } catch {
      next = undefined;
    }
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };
  void read();
  // why: the first stream is the sign-in's own, which the read above already covers.
  connection.onStreamOpened((opened) => {
    if (opened.closedForMs !== undefined) void read();
  });
  return {
    mode: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
