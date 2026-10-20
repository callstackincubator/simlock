import { describe, expect, it, vi } from "vitest";

import { createApiClient, type Fetch } from "./api";
import { createSession } from "./session";

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

const ALICE = { name: "Alice", principal: "proxy:https://idp#u1", role: "admin", via: "proxy" };
const EXPIRED = { error: { code: "UNAUTHENTICATED", message: "refused", reason: "expired" } };
const HTML_403 = () => new Response("<html>Sign in</html>", { status: 403 });
const NOW = 1_700_000_000_000;

type Handler = () => Response | Promise<Response>;

// why: a session in a page that loads over and over: the page's memory is the session, its
// storage and the proxy are what a reload keeps.
function page(handlers: { identity: Handler; healthz?: Handler; workers?: Handler }) {
  const storage = memoryStorage();
  const calls: string[] = [];
  const routes = { ...handlers };
  const fetch: Fetch = async (input) => {
    calls.push(input);
    const route =
      input === "/v1/identity"
        ? routes.identity
        : input === "/v1/healthz"
          ? routes.healthz
          : routes.workers;
    if (route === undefined) throw new TypeError("Failed to fetch");
    return route();
  };
  const reload = vi.fn();
  let now = NOW;
  const open = (store: () => typeof storage | typeof refusing = () => storage) => {
    const session = createSession(store, { fetch, now: () => now, reload });
    const api = createApiClient({
      fetch,
      onRefused: session.refused,
      signOut: () => {},
      token: session.token,
    });
    return { api, session };
  };
  return {
    calls,
    elapse: (ms: number) => void (now += ms),
    open,
    reload,
    routes,
    storage,
  };
}

const answers =
  (status: number, body: unknown): Handler =>
  () =>
    new Response(JSON.stringify(body), { status });
const healthz: Handler = () => new Response('{"ok":true}', { status: 200 });

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("a session behind a sign-in proxy", () => {
  it("opens as the person the proxy signed in, and as nobody when it did not", async () => {
    const proxied = page({ identity: answers(200, ALICE) });
    const { session } = proxied.open();

    const states: unknown[] = [];
    session.subscribe(() => states.push(session.state()));
    session.start();
    await vi.waitFor(() => expect(session.state()).toEqual({ kind: "proxy", name: "Alice" }));

    expect(states).toEqual([{ kind: "checking" }, { kind: "proxy", name: "Alice" }]);
    const direct = page({ identity: answers(401, { error: { code: "UNAUTHENTICATED" } }) });
    const opened = direct.open().session;
    opened.start();
    await vi.waitFor(() => expect(opened.state()).toEqual({ kind: "none" }));
  });

  it("three requests answering 401 at once start one identity check, whose outcome becomes the session", async () => {
    const proxied = page({
      identity: answers(200, ALICE),
      workers: answers(401, { error: { code: "UNAUTHENTICATED" } }),
    });
    const { api, session } = proxied.open();
    session.start();
    await vi.waitFor(() => expect(session.state().kind).toBe("proxy"));
    const identityCalls = () => proxied.calls.filter((call) => call === "/v1/identity").length;
    expect(identityCalls()).toBe(1);
    let release: (response: Response) => void = () => {};
    proxied.routes.identity = () => new Promise<Response>((resolve) => (release = resolve));

    const requests = [1, 2, 3].map(() => api.getJson("/v1/workers").catch(() => "refused"));
    await Promise.all(requests);
    await settled();
    expect(identityCalls()).toBe(2);
    release(new Response(JSON.stringify(EXPIRED), { status: 401 }));

    await vi.waitFor(() =>
      expect(session.state()).toEqual({ kind: "none", refusedReason: "expired" }),
    );
    expect(identityCalls()).toBe(2);
  });

  it("a 401 in a token session forgets the token and starts the identity check", async () => {
    const proxied = page({
      identity: answers(200, ALICE),
      workers: answers(401, { error: { code: "UNAUTHENTICATED" } }),
    });
    proxied.storage.setItem("simlock.operatorToken", "slk_revoked");
    const { api, session } = proxied.open();

    await expect(api.getJson("/v1/workers")).rejects.toMatchObject({ status: 401 });

    expect(session.token()).toBeUndefined();
    expect(proxied.storage.items.size).toBe(0);
    await vi.waitFor(() => expect(session.state()).toEqual({ kind: "proxy", name: "Alice" }));
    expect(proxied.calls.filter((call) => call === "/v1/identity")).toHaveLength(1);
  });

  it("the proxy's own session ending reloads the page, and a second ending within 60 seconds shows the ended screen instead", async () => {
    const proxied = page({ healthz, identity: answers(200, ALICE), workers: HTML_403 });
    const first = proxied.open();
    first.session.start();
    await vi.waitFor(() => expect(first.session.state().kind).toBe("proxy"));
    proxied.routes.identity = HTML_403;

    await first.api.getJson("/v1/workers").catch(() => undefined);
    await vi.waitFor(() => expect(proxied.reload).toHaveBeenCalledTimes(1));

    proxied.routes.identity = answers(200, ALICE);
    proxied.elapse(59_999);
    const second = proxied.open();
    second.session.start();
    await vi.waitFor(() => expect(second.session.state().kind).toBe("proxy"));
    proxied.routes.identity = HTML_403;
    await second.api.getJson("/v1/workers").catch(() => undefined);
    await vi.waitFor(() => expect(second.session.state()).toEqual({ kind: "ended" }));
    expect(proxied.reload).toHaveBeenCalledTimes(1);

    proxied.routes.identity = answers(200, ALICE);
    proxied.elapse(1);
    const third = proxied.open();
    third.session.start();
    await vi.waitFor(() => expect(third.session.state().kind).toBe("proxy"));
    proxied.routes.identity = HTML_403;
    await third.api.getJson("/v1/workers").catch(() => undefined);
    await vi.waitFor(() => expect(proxied.reload).toHaveBeenCalledTimes(2));
  });

  it("shows the ended screen and never reloads when the browser refuses storage", async () => {
    const proxied = page({ healthz, identity: answers(200, ALICE), workers: HTML_403 });
    const { api, session } = proxied.open(() => refusing);
    session.start();
    await vi.waitFor(() => expect(session.state().kind).toBe("proxy"));
    proxied.routes.identity = HTML_403;

    await api.getJson("/v1/workers").catch(() => undefined);

    await vi.waitFor(() => expect(session.state()).toEqual({ kind: "ended" }));
    expect(proxied.reload).not.toHaveBeenCalled();
  });

  it("changes nothing when the daemon is unreachable, and counts an ended session as nobody at load", async () => {
    const proxied = page({ identity: answers(200, ALICE) });
    const { api, session } = proxied.open();
    session.start();
    await vi.waitFor(() => expect(session.state().kind).toBe("proxy"));
    proxied.routes.identity = () => {
      throw new TypeError("Failed to fetch");
    };

    await api.getJson("/v1/workers").catch(() => undefined);
    await settled();

    expect(session.state()).toEqual({ kind: "proxy", name: "Alice" });
    expect(proxied.reload).not.toHaveBeenCalled();

    const loading = page({ healthz, identity: HTML_403 });
    const loaded = loading.open().session;
    loaded.start();
    await vi.waitFor(() => expect(loaded.state()).toEqual({ kind: "none" }));
    expect(loading.reload).not.toHaveBeenCalled();
  });

  it("keeps the token when a token session gets an answer that is not Simlock's, a 401 or a 403", async () => {
    for (const status of [401, 403]) {
      const proxied = page({
        healthz,
        identity: answers(200, ALICE),
        workers: () => new Response("<html>Sign in</html>", { status }),
      });
      proxied.storage.setItem("simlock.operatorToken", "slk_op");
      const { api, session } = proxied.open();

      await api.getJson("/v1/workers").catch(() => undefined);
      await settled();

      expect(session.state()).toEqual({ kind: "token", token: "slk_op" });
      expect(proxied.storage.getItem("simlock.operatorToken")).toBe("slk_op");
      expect(proxied.calls).not.toContain("/v1/identity");
    }
  });

  it("counts an unreachable daemon at load as nobody signed in", async () => {
    const loading = page({
      identity: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { session } = loading.open();

    session.start();

    await vi.waitFor(() => expect(session.state()).toEqual({ kind: "none" }));
    expect(loading.reload).not.toHaveBeenCalled();
  });

  it("tells a lost live connection to reconnect, back off or stop, by the identity check", async () => {
    const cases = [
      { answer: "reconnect", identity: answers(200, ALICE), reloads: 0, state: "proxy" },
      {
        answer: "backoff",
        identity: () => {
          throw new TypeError("Failed to fetch");
        },
        reloads: 0,
        state: "proxy",
      },
      {
        answer: "backoff",
        identity: answers(502, { error: { code: "BAD_GATEWAY" } }),
        reloads: 0,
        state: "proxy",
      },
      { answer: "stop", identity: HTML_403, reloads: 1, state: "proxy" },
      { answer: "stop", identity: answers(200, { via: "token" }), reloads: 0, state: "none" },
    ] as const;
    for (const { answer, identity, reloads, state } of cases) {
      const proxied = page({ healthz, identity: answers(200, ALICE) });
      const { session } = proxied.open();
      session.start();
      await vi.waitFor(() => expect(session.state().kind).toBe("proxy"));
      proxied.routes.identity = identity;
      if (answer === "backoff") delete proxied.routes.healthz;

      expect(await session.lost()).toBe(answer);

      expect(session.state().kind).toBe(state);
      expect(proxied.reload).toHaveBeenCalledTimes(reloads);
    }
  });

  it("leaves a lost live connection to its backoff outside a proxy session, without a check", async () => {
    const proxied = page({ identity: answers(200, ALICE) });
    proxied.storage.setItem("simlock.operatorToken", "slk_op");
    const { session } = proxied.open();

    expect(await session.lost()).toBe("backoff");
    expect(proxied.calls).toEqual([]);
  });

  it("does not undo a token signed in while the identity check ran", async () => {
    const proxied = page({ identity: answers(200, ALICE) });
    let release: (response: Response) => void = () => {};
    proxied.routes.identity = () => new Promise<Response>((resolve) => (release = resolve));
    const { session } = proxied.open();
    session.start();

    session.signIn("slk_op");
    release(new Response(JSON.stringify(ALICE), { status: 200 }));
    await settled();

    expect(session.state()).toEqual({ kind: "token", token: "slk_op" });
  });
});
