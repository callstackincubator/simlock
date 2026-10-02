/**
 * The operator's token, kept per tab (ADR 0011 §6): in `sessionStorage`, so a reload keeps the
 * operator signed in and a new tab asks again. Nothing else in the console stores it.
 */

const STORAGE_KEY = "simlock.operatorToken";

type Storage = Pick<globalThis.Storage, "getItem" | "removeItem" | "setItem">;

export interface Session {
  token(): string | undefined;
  signIn(token: string): void;
  signOut(): void;
  /** For `useSyncExternalStore`: called after every sign-in and sign-out. */
  subscribe(listener: () => void): () => void;
}

/**
 * `storage` is asked for lazily, because a browser with site data blocked throws on merely
 * reading `window.sessionStorage`; it may also refuse each read and write. The console then
 * still signs in, and the token lives only as long as the page.
 */
export function createSession(storage: () => Storage): Session {
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
    token: () => current,
    signIn: (token) => update(token),
    signOut: () => update(undefined),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Runs a storage call, treating a refusal as "nothing stored". */
function attempt<T>(call: () => T): T | undefined {
  try {
    return call();
  } catch {
    return undefined;
  }
}
