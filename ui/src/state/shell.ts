import { useEffect } from "react";

import type { ConnectionPhase } from "../data/live/connection";
import { problemCount } from "../../../src/contract/inbox";
import type { InboxList } from "../model/inbox";
import { formatDuration } from "../model/time";
import type { Toned } from "../model/tones";
import { useConnection, useNow, useRouteQuery, useSignedInIdentity } from "./live";
import { useApi, useSession } from "./services";

export function useInboxCount(): number | undefined {
  const items = useRouteQuery<InboxList>("/v1/inbox").data?.items;
  return items === undefined ? undefined : problemCount(items);
}

// why: a 401 at any time signs the operator out; a tab reloaded with a token since revoked finds out
// here, before any screen asks for data.
export function useTokenCheck(): void {
  const api = useApi();
  useEffect(() => {
    api.getJson("/v1/workers").catch(() => undefined);
  }, [api]);
}

export interface SignedIn {
  readonly name: string | undefined;
  readonly readOnly: boolean;
  // why: a proxy person with no sign-out address has nowhere to go, so there is no Sign out.
  readonly canSignOut: boolean;
}

export function useSignedIn(): SignedIn {
  const { canSignOut, name, role } = useSignedInIdentity();
  return { canSignOut, name, readOnly: role === "viewer" };
}

export function useSignOut(): () => void {
  const session = useSession();
  return () => {
    const state = session.state();
    if (state.kind === "proxy") {
      if (state.signOutUrl !== undefined) window.location.assign(state.signOutUrl);
    } else session.signOut();
  };
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
