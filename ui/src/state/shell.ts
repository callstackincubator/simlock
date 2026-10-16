import { useEffect } from "react";

import type { ConnectionPhase } from "../data/live/connection";
import { attentionItems } from "../model/attention";
import { formatDuration } from "../model/time";
import type { Toned } from "../model/tones";
import type { WorkerList } from "../model/workers";
import { useConnection, useLiveResource, useNow } from "./live";
import { useApi, useSession } from "./services";

export function useAttentionCount(): number | undefined {
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers;
  return workers === undefined ? undefined : attentionItems(workers).length;
}

// why: a 401 at any time signs the operator out; a tab reloaded with a token since revoked finds out
// here, before any screen asks for data.
export function useTokenCheck(): void {
  const api = useApi();
  useEffect(() => {
    api.getJson("/v1/workers").catch(() => undefined);
  }, [api]);
}

export function useSignOut(): () => void {
  const session = useSession();
  return () => session.signOut();
}

const PHASES: Readonly<Record<ConnectionPhase, Toned>> = {
  connected: { tone: "ok", word: "Connected" },
  disconnected: { tone: "error", word: "Reconnecting" },
  starting: { tone: "warn", word: "Daemon is starting" },
};

// why: the data's age shows only while reconnecting; while the daemon starts it is about to answer.
export function useConnectionStatus(): Toned & { readonly age?: string } {
  const state = useConnection();
  const now = useNow();
  const shown = PHASES[state.phase];
  if (state.phase !== "disconnected" || state.answeredAt === undefined) return shown;
  return { ...shown, age: formatDuration(now.browser - state.answeredAt) };
}
