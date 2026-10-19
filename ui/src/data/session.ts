import type { ApiFailure, Fetch } from "./api";
import type { LostAnswer } from "./live/connection";
import { checkIdentity, type IdentityOutcome } from "./identity-check";

const STORAGE_KEY = "simlock.operatorToken";

type Storage = Pick<globalThis.Storage, "getItem" | "removeItem" | "setItem">;

export type SessionState =
  | { readonly kind: "none"; readonly refusedReason?: string }
  | { readonly kind: "checking" }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "proxy"; readonly name: string; readonly signOutUrl?: string }
  | { readonly kind: "ended" };

export interface SessionDeps {
  readonly fetch: Fetch;
  readonly reload: () => void;
  readonly now: () => number;
}

export interface Session {
  state(): SessionState;
  start(): void;
  refused(failure: ApiFailure): void;
  lost(): Promise<LostAnswer>;
  token(): string | undefined;
  signIn(token: string): void;
  signOut(): void;
  subscribe(listener: () => void): () => void;
}

const RELOAD_KEY = "simlock.proxyReloadAt";
const RELOAD_GAP_MS = 60_000;

// why: `storage` is asked for lazily, because a browser with site data blocked throws on merely
// reading `window.sessionStorage`; it may also refuse each read and write, and the console then
// still signs in with the token living only as long as the page.
export function createSession(storage: () => Storage, deps?: SessionDeps): Session {
  const listeners = new Set<() => void>();
  let token = attempt(() => storage().getItem(STORAGE_KEY) ?? undefined);
  let state: SessionState = token === undefined ? { kind: "none" } : { kind: "token", token };
  let inFlight: Promise<IdentityOutcome> | undefined;

  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const store = (next: string | undefined) => {
    token = next;
    attempt(() =>
      next === undefined ? storage().removeItem(STORAGE_KEY) : storage().setItem(STORAGE_KEY, next),
    );
  };
  // why: callers while a check runs get its outcome, and only the first applies it.
  const check = (afterLoss: boolean): Promise<IdentityOutcome> | undefined => {
    if (deps === undefined) return undefined;
    if (inFlight !== undefined) return inFlight;
    const running = checkIdentity(deps.fetch, afterLoss).finally(() => {
      inFlight = undefined;
    });
    inFlight = running;
    return running;
  };
  const apply = (outcome: IdentityOutcome, atLoad: boolean) => {
    switch (outcome.kind) {
      case "proxy":
        return set(proxyState(outcome));
      case "refused":
        return set({ kind: "none", refusedReason: outcome.reason });
      case "ended":
        return atLoad ? set({ kind: "none" }) : ended();
      case "unreachable":
        return atLoad ? set({ kind: "none" }) : undefined;
      case "none":
        return set({ kind: "none" });
    }
  };
  const opening = async (atLoad: boolean) => {
    const first = inFlight === undefined;
    const running = check(!atLoad);
    if (running === undefined) return set({ kind: "none" });
    const outcome = await running;
    // why: only the caller that started the check applies its outcome, and a token signed in while
    // it ran is not undone by it.
    if (first && state.kind !== "token") apply(outcome, atLoad);
  };
  // why: a proxy's login page cannot be drawn in this page, so the page reloads to let the proxy
  // show it; a second ending within a minute of the reload would loop, and a browser that keeps no
  // storage could never tell, so both stop at the ended screen.
  const ended = () => {
    if (deps === undefined) return set({ kind: "ended" });
    const reloadedAt = Number(attempt(() => storage().getItem(RELOAD_KEY)));
    const recent = deps.now() - reloadedAt < RELOAD_GAP_MS;
    const stored =
      !recent && attempt(() => (storage().setItem(RELOAD_KEY, String(deps.now())), true)) === true;
    if (stored) deps.reload();
    else set({ kind: "ended" });
  };
  return {
    state: () => state,
    start() {
      if (state.kind !== "none") return;
      set({ kind: "checking" });
      void opening(true);
    },
    refused(failure) {
      if (state.kind === "token") {
        if (failure !== "unauthorized") return;
        store(undefined);
        set({ kind: "checking" });
        void opening(true);
      } else if (state.kind === "proxy") {
        void opening(false);
      }
    },
    // why: a proxy session's live connection asks here before its backoff, because a lost stream
    // may be the proxy's session ending; any other session is "Simlock is unreachable" as before.
    async lost() {
      if (state.kind !== "proxy") return "backoff";
      const first = inFlight === undefined;
      const running = check(true);
      if (running === undefined) return "backoff";
      const outcome = await running;
      if (outcome.kind === "proxy") return "reconnect";
      if (outcome.kind === "unreachable") return "backoff";
      if (first && state.kind === "proxy") apply(outcome, false);
      return "stop";
    },
    token: () => token,
    signIn(next) {
      store(next);
      set({ kind: "token", token: next });
    },
    signOut() {
      if (state.kind !== "token") return;
      store(undefined);
      if (deps === undefined) return set({ kind: "none" });
      set({ kind: "checking" });
      void opening(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function proxyState(outcome: Extract<IdentityOutcome, { kind: "proxy" }>): SessionState {
  return outcome.signOutUrl === undefined
    ? { kind: "proxy", name: outcome.name }
    : { kind: "proxy", name: outcome.name, signOutUrl: outcome.signOutUrl };
}

function attempt<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
