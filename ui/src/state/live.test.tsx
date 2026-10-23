import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient, ApiResponse } from "../data/api";
import { connect, settle } from "../data/live/test-support";
import { LiveProvider } from "./live";
import { ConsoleProvider } from "./services";

// why: a server render never runs effects, and the console has no DOM to mount into, so the
// provider's effect is captured here and run by the test, which then calls the cleanup it returns.
const effects = vi.hoisted(() => ({ run: undefined as undefined | (() => () => void) }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => () => void) => {
    effects.run = effect;
  },
  useState: (initial: unknown) => [initial, () => undefined],
}));

vi.mock("../data/live/browser", async () => ({
  browserClock: (await import("../data/live/test-support")).fakeClock,
  documentVisibility: { hidden: () => false, subscribe: () => () => undefined },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("the live provider", () => {
  it("stops re-reading the daemon's status every 10 minutes once it is unmounted", async () => {
    const { daemon } = connect();
    let statusReads = 0;
    daemon.reads = (path): Promise<ApiResponse<unknown>> => {
      if (path === "/v1/status") statusReads += 1;
      return Promise.resolve({
        body: path === "/v1/status" ? { daemon: { mode: "gateway" } } : { workers: [] },
        date: null,
      });
    };
    // why: a stream that never opens cannot reconnect, so only the 10-minute timer re-reads.
    daemon.holdStreams = true;
    const services = {
      api: daemon as unknown as ApiClient,
      confirm: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error("unused")),
      notify: () => undefined,
      preferences: {} as never,
      session: { lost: () => undefined } as never,
    };
    const node: ReactNode = (
      <ConsoleProvider {...services}>
        <LiveProvider>{null}</LiveProvider>
      </ConsoleProvider>
    );
    renderToStaticMarkup(node);

    const unmount = effects.run?.();
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(statusReads).toBe(2);

    unmount?.();
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(statusReads).toBe(2);
  });
});
