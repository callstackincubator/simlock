import { describe, expect, it } from "vitest";

import { createSession } from "./session";

/** A `sessionStorage` stand-in that keeps what it is given. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => void items.delete(key),
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const refusing = {
  getItem: (): string | null => {
    throw new DOMException("blocked", "SecurityError");
  },
  removeItem: (): void => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: (): void => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("createSession", () => {
  it("keeps the token in storage, so a reloaded page starts signed in", () => {
    const storage = memoryStorage();
    const first = createSession(() => storage);
    const changes: (string | undefined)[] = [];
    first.subscribe(() => changes.push(first.token()));

    first.signIn("slk_op");
    const reloaded = createSession(() => storage);
    first.signOut();
    const afterSignOut = createSession(() => storage);

    expect(reloaded.token()).toBe("slk_op");
    expect(afterSignOut.token()).toBeUndefined();
    expect(storage.items.size).toBe(0);
    expect(changes).toEqual(["slk_op", undefined]);
  });

  it("still signs in and out when the browser refuses storage, keeping the token in the page", () => {
    // Either each call is refused, or reading `window.sessionStorage` itself throws.
    const unreachable = (): typeof refusing => {
      throw new DOMException("blocked", "SecurityError");
    };
    for (const storage of [() => refusing, unreachable]) {
      const session = createSession(storage);

      expect(session.token()).toBeUndefined();
      session.signIn("slk_op");
      expect(session.token()).toBe("slk_op");
      session.signOut();
      expect(session.token()).toBeUndefined();
    }
  });
});
