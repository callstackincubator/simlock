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
 * `storage` may be missing or refuse writes (a browser with site data blocked). The console then
 * still signs in, and the token lives only as long as the page.
 */
export function createSession(storage: Storage | undefined): Session {
  const listeners = new Set<() => void>();
  let current = read(storage);
  const update = (token: string | undefined) => {
    current = token;
    try {
      if (token === undefined) storage?.removeItem(STORAGE_KEY);
      else storage?.setItem(STORAGE_KEY, token);
    } catch {
      // Kept in memory only; see above.
    }
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

function read(storage: Storage | undefined): string | undefined {
  try {
    return storage?.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
