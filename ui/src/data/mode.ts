import type { ApiClient } from "./api";
import type { Clock, LiveConnection } from "./live/connection";

export type DaemonMode = "gateway" | "worker";

// why: what the footer reads of the daemon beside its mode: the version it runs and the latest the
// gateway knows (`null` when it knows none).
export interface DaemonFacts {
  readonly version?: string;
  readonly latestVersion: string | null;
}

export interface ModeStore {
  readonly mode: () => DaemonMode | undefined;
  readonly daemon: () => DaemonFacts;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

interface StatusBody {
  readonly daemon?: {
    readonly mode?: unknown;
    readonly version?: unknown;
    readonly latestVersion?: unknown;
  };
}

const NO_FACTS: DaemonFacts = { latestVersion: null };
const RE_READ_MS = 600_000;

interface Reading {
  readonly mode: DaemonMode | undefined;
  readonly facts: DaemonFacts;
}

function readingOf(body: StatusBody): Reading {
  const { mode, version, latestVersion } = body.daemon ?? {};
  return {
    facts: {
      latestVersion: typeof latestVersion === "string" ? latestVersion : null,
      ...(typeof version === "string" ? { version } : {}),
    },
    mode: mode === "gateway" || mode === "worker" ? mode : undefined,
  };
}

// why: ADR 0037 §4. The console reads `daemon.mode` from `GET /v1/status` once it is signed in and
// again after every reconnect. A read that fails or names a mode this console does not know leaves
// none, so nothing is ever offered on a guess. ADR 0042: the daemon's version and `latestVersion`
// come from the same read, which also repeats every 10 minutes because the daily check emits no
// event; that repeat keeps the last values when it fails, only the sign-in and reconnect reads
// clear them.
export function watchMode(options: {
  readonly api: Pick<ApiClient, "get">;
  readonly connection: Pick<LiveConnection, "onStreamOpened">;
  readonly clock: Pick<Clock, "setTimeout" | "clearTimeout">;
}): ModeStore {
  const { api, clock, connection } = options;
  const listeners = new Set<() => void>();
  let current: Reading = { facts: NO_FACTS, mode: undefined };
  let timer: unknown;
  const read = async (keepOnFailure: boolean) => {
    let next: Reading;
    try {
      next = readingOf((await api.get<StatusBody>("/v1/status")).body);
    } catch {
      if (keepOnFailure) return;
      next = { facts: NO_FACTS, mode: undefined };
    }
    if (
      next.mode === current.mode &&
      next.facts.version === current.facts.version &&
      next.facts.latestVersion === current.facts.latestVersion
    ) {
      return;
    }
    current = next;
    for (const listener of listeners) listener();
  };
  const again = () => {
    timer = clock.setTimeout(() => {
      void read(true);
      again();
    }, RE_READ_MS);
  };
  void read(false);
  again();
  // why: the first stream is the sign-in's own, which the read above already covers.
  connection.onStreamOpened((opened) => {
    if (opened.closedForMs !== undefined) void read(false);
  });
  return {
    daemon: () => current.facts,
    dispose() {
      clock.clearTimeout(timer);
    },
    mode: () => current.mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
