import type { ApiFailure, Fetch } from "./api";

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
  token(): string | undefined;
  signIn(token: string): void;
  signOut(): void;
  subscribe(listener: () => void): () => void;
}

// why: `storage` is asked for lazily, because a browser with site data blocked throws on merely
// reading `window.sessionStorage`; it may also refuse each read and write, and the console then
// still signs in with the token living only as long as the page.
export function createSession(storage: () => Storage, _deps?: SessionDeps): Session {
  const listeners = new Set<() => void>();
  let current = attempt(() => storage().getItem(STORAGE_KEY) ?? undefined);
  const update = (token: string | undefined) => {
    current = token;
    attempt(() =>
      token === undefined
        ? storage().removeItem(STORAGE_KEY)
        : storage().setItem(STORAGE_KEY, token),
    );
    for (const listener of listeners) listener();
  };
  return {
    state: () => (current === undefined ? { kind: "none" } : { kind: "token", token: current }),
    start: () => {},
    refused: () => {},
    token: () => current,
    signIn: (token) => update(token),
    signOut: () => update(undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function attempt<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
