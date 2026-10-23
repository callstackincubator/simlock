import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient, ApiResponse } from "../data/api";
import type { DaemonMode } from "../data/mode";
import { connect, fakeClock, settle } from "../data/live/test-support";
import { createQueries } from "./queries";
import { type Live, LiveContext } from "./live";
import { ConsoleProvider } from "./services";
import { useWorkerEvents } from "./workers";

// why: a server render never runs effects and keeps no state between renders, so the effects of each
// render are collected for the test to run, and useState and useRef keep their slot across renders.
const rendered = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  slot: 0,
  slots: [] as unknown[],
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    rendered.effects.push(effect);
  },
  useRef: <T,>(initial: T) => {
    const at = rendered.slot++;
    rendered.slots[at] ??= { current: initial };
    return rendered.slots[at];
  },
  useState: <T,>(initial: T | (() => T)) => {
    const at = rendered.slot++;
    rendered.slots[at] ??= typeof initial === "function" ? (initial as () => T)() : initial;
    return [rendered.slots[at], () => undefined];
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

function streamed(id: string, seq: number): string {
  const data = {
    event: "lease.renewed",
    id,
    payload: { leaseId: "l1" },
    seq,
    timestamp: Date.now(),
  };
  return `event: lease.renewed\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("a worker's Events tab", () => {
  it("follows the daemon mode as it arrives: a single host's streamed event, which names no worker, shows once the mode is known to be a worker's", async () => {
    vi.stubGlobal("window", { location: { pathname: "/workers/w1", search: "?tab=events" } });
    const { connection, daemon, visibility } = connect();
    daemon.reads = (path): Promise<ApiResponse<unknown>> =>
      Promise.resolve({ body: path.startsWith("/v1/events") ? { events: [] } : {}, date: null });
    const queries = createQueries({ clock: fakeClock, connection, visibility });
    queries.client.setQueryData(["workers"], { workers: [] });
    let mode: DaemonMode | undefined;
    const live = {
      connection,
      mode: {
        daemon: () => ({}),
        dispose: () => undefined,
        mode: () => mode,
        subscribe: () => () => undefined,
      },
      queries,
      recent: {},
    } as unknown as Live;
    const services = {
      api: {
        getJson: (path: string) => daemon.get(path as never).then((answer) => answer.body),
      } as unknown as ApiClient,
      confirm: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error("unused")),
      notify: () => undefined,
      preferences: {} as never,
      session: {} as never,
    };
    let held: ReturnType<typeof useWorkerEvents> | undefined;
    const Probe = () => {
      held = useWorkerEvents("w1");
      return null;
    };
    const render = (): void => {
      rendered.slot = 0;
      renderToStaticMarkup(
        <ConsoleProvider {...services}>
          <LiveContext.Provider value={live}>
            <Probe />
          </LiveContext.Provider>
        </ConsoleProvider>,
      );
    };
    const rows = (): number => (held?.kind === "ready" ? held.data.rows.length : -1);

    await settle();
    render();
    for (const effect of rendered.effects) effect();
    rendered.effects = [];
    await settle();
    mode = "worker";
    render();
    for (const effect of rendered.effects) effect();
    rendered.effects = [];
    daemon.openStream()?.send(streamed("e1", 1));
    await settle();
    render();
    expect(rows()).toBe(1);
  });
});
