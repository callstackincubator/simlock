import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient, ApiResponse } from "../data/api";
import { createRecentFeed } from "../data/recent-feed";
import { connect, fakeClock, settle } from "../data/live/test-support";
import { createQueries } from "./queries";
import { type Live, LiveContext } from "./live";
import { useInbox } from "./inbox";
import { useLeaseEvents } from "./leases";
import { ConsoleProvider } from "./services";

// why: a server render never runs effects and the console has no DOM to mount into, so the effects
// of each render are collected here for the test to run (mount) and to undo (unmount).
const rendered = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    rendered.effects.push(effect);
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

vi.mock("../data/live/browser", async () => ({
  browserClock: (await import("../data/live/test-support")).fakeClock,
  documentVisibility: { hidden: () => false, subscribe: () => () => undefined },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LEASE = "l1";

function streamed(id: string, seq: number): string {
  const data = {
    event: "lease.renewed",
    id,
    payload: { leaseId: LEASE },
    seq,
    timestamp: Date.now(),
  };
  return `event: lease.renewed\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("the recent events of a tab", () => {
  it("are shared by the Inbox and the lease drawer, and kept 60 seconds after the last of them closes", async () => {
    vi.stubGlobal("window", { location: { pathname: "/inbox", search: "" } });
    const { connection, daemon, visibility } = connect();
    daemon.reads = (path): Promise<ApiResponse<unknown>> =>
      Promise.resolve({ body: path.startsWith("/v1/events") ? { events: [] } : {}, date: null });
    const queries = createQueries({ clock: fakeClock, connection, visibility });
    const now = Date.now();
    const live = {
      connection,
      queries,
      recent: createRecentFeed({
        clock: fakeClock,
        connection,
        get: (path) => daemon.get(path).then((answer) => answer.body),
      }),
      ticker: {
        dispose: () => undefined,
        now: () => ({ browser: now, server: now }),
        subscribe: () => () => undefined,
      },
    } as unknown as Live;
    queries.client.setQueryData(["workers"], { workers: [] });
    queries.client.setQueryData(["inbox"], {
      items: [
        {
          condition: "ending",
          group: "Heads-up",
          key: `lease/${LEASE}/ending`,
          lease: {
            deviceId: "d1",
            holder: "agent",
            id: LEASE,
            model: "iPhone",
            requesterId: "a1",
            ttlDeadline: now + 60_000,
          },
        },
      ],
    });
    const services = {
      api: {} as ApiClient,
      confirm: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error("unused")),
      notify: () => undefined,
      preferences: {} as never,
      session: {} as never,
    };

    // why: mounting renders the hook once and runs its effects; the render after shows what it holds.
    function mount<T>(hook: () => T): { read: () => T; unmount: () => void } {
      const Probe = ({ out }: { out: { value?: T } }) => {
        out.value = hook();
        return null;
      };
      const render = (): { value?: T } => {
        const out: { value?: T } = {};
        rendered.effects = [];
        renderToStaticMarkup(
          <ConsoleProvider {...services}>
            <LiveContext.Provider value={live}>
              <Probe out={out} />
            </LiveContext.Provider>
          </ConsoleProvider>,
        );
        return out;
      };
      render();
      const cleanups = rendered.effects.map((effect) => effect());
      return {
        read: () => render().value as T,
        unmount: () => {
          for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
        },
      };
    }
    const inboxEvents = (inbox: ReturnType<typeof useInbox>): number => {
      const { view } = inbox;
      if (view.kind !== "ready" || typeof view.data.shown !== "object") return -1;
      return view.data.shown.events.length;
    };
    const leaseRows = (view: ReturnType<typeof useLeaseEvents>): number =>
      view.kind === "ready" ? view.data.length : -1;
    const recentReads = (): number =>
      daemon.gets.filter((get) => get.path === "/v1/events?since=1h").length;

    await settle();
    const inbox = mount(() => useInbox());
    const drawer = mount(() => useLeaseEvents(LEASE));
    await settle();
    daemon.openStream()?.send(streamed("e1", 1));
    await settle();
    expect(recentReads()).toBe(1);
    expect([inboxEvents(inbox.read()), leaseRows(drawer.read())]).toEqual([1, 1]);

    inbox.unmount();
    await vi.advanceTimersByTimeAsync(61_000);
    daemon.openStream()?.send(streamed("e1b", 2));
    await settle();
    expect(leaseRows(drawer.read())).toBe(2);

    drawer.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    daemon.openStream()?.send(streamed("e2", 3));
    await vi.advanceTimersByTimeAsync(20_000);
    const back = mount(() => useLeaseEvents(LEASE));
    await settle();
    expect(leaseRows(back.read())).toBe(3);
    expect(recentReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    // why: the quiet stream was dropped at 40 s and is open again after its 1 s retry.
    await vi.advanceTimersByTimeAsync(2_000);
    daemon.openStream()?.send(streamed("e3", 4));
    await settle();
    // why: the reconnect after the quiet drop is read once, as a gap read, by the shared list.
    const gapReads = (): number =>
      daemon.gets.filter(
        (get) => get.path.startsWith("/v1/events?since=") && get.path !== "/v1/events?since=1h",
      ).length;
    expect(gapReads()).toBe(1);
    expect(leaseRows(back.read())).toBe(4);

    back.unmount();
    await vi.advanceTimersByTimeAsync(61_000);
    // why: a dropped list is stopped, so a stream that reconnects now is read by nobody.
    const before = gapReads();
    daemon.openStream()?.break();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gapReads()).toBe(before);
    const late = mount(() => useLeaseEvents(LEASE));
    await settle();
    expect(recentReads()).toBe(2);
    late.unmount();
  });
});
