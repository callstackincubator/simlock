import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, RequestTimeoutError } from "../data/api";
import { connect, fakeClock, settle } from "../data/live/test-support";
import { createQueries, type Queries, routeKey } from "./queries";

const EVENT = 'event: lease.granted\ndata: {"seq":1,"timestamp":1,"event":"lease.granted"}\n\n';

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

function start(keepAlive = true) {
  const live = connect();
  const queries: Queries = createQueries({
    clock: fakeClock,
    connection: live.connection,
    visibility: live.visibility,
  });
  // why: a stream silent for 40 seconds counts as lost, as the daemon's keepalives prevent.
  const keepalive = setInterval(() => live.daemon.openStream()?.send(": keepalive\n\n"), 15_000);
  if (!keepAlive) clearInterval(keepalive);
  disposers.push(() => {
    clearInterval(keepalive);
    queries.dispose();
    live.connection.dispose();
  });
  const watch = (path: ApiPath) =>
    new QueryObserver(queries.client, queries.options(path)).subscribe(() => undefined);
  const state = (path: ApiPath) => {
    const query = queries.client.getQueryState(routeKey(path));
    return { data: query?.data, error: query?.error ?? undefined };
  };
  const reads = (path: ApiPath) => live.daemon.gets.filter((get) => get.path === path).length;
  return { ...live, queries, reads, state, watch };
}

describe("the query layer", () => {
  it("a page on screen polls its keys; leaving or hiding stops it", async () => {
    const intervals = [
      ["/v1/lease-requests", 5_000],
      ["/v1/leases", 10_000],
      ["/v1/leases/l_1", 10_000],
      ["/v1/workers", 15_000],
      ["/v1/stats?since=1h", 60_000],
    ] as const;
    for (const [path, every] of intervals) {
      const { reads, watch } = start();
      const leave = watch(path);
      await settle();
      expect(reads(path), `${path} first read`).toBe(1);
      await vi.advanceTimersByTimeAsync(every - 1);
      expect(reads(path), `${path} just before ${every}`).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads(path), `${path} at ${every}`).toBe(2);
      await vi.advanceTimersByTimeAsync(every);
      expect(reads(path), `${path} at twice ${every}`).toBe(3);

      leave();
      await vi.advanceTimersByTimeAsync(every * 3);
      expect(reads(path), `${path} after leaving`).toBe(3);
    }

    const { reads: tokenReads, watch: watchTokens } = start();
    watchTokens("/v1/tokens");
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tokenReads("/v1/tokens"), "tokens are read once and never polled").toBe(1);

    const { daemon, visibility, watch: watchPage } = start();
    watchPage("/v1/workers");
    watchPage("/v1/leases");
    await settle();
    expect(daemon.gets).toHaveLength(2);

    visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.gets, "hidden").toHaveLength(2);

    visibility.set(false);
    await settle();
    expect(
      daemon.gets
        .map((get) => get.path)
        .slice(2)
        .sort(),
    ).toEqual(["/v1/leases", "/v1/workers"]);

    daemon.health = "down";
    daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.gets, "disconnected").toHaveLength(4);

    daemon.health = "up";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      daemon.gets
        .map((get) => get.path)
        .slice(4)
        .sort(),
    ).toEqual(["/v1/leases", "/v1/workers"]);
  });
});

describe("a read's answers and failures", () => {
  it("a read that fails at the network level marks the console disconnected", async () => {
    const { daemon, connection, state, watch } = start(false);
    daemon.reads = () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error"));
    watch("/v1/workers");
    await settle();
    expect(connection.state().phase).toBe("connected");
    expect(state("/v1/workers").error).toBeInstanceOf(ApiError);

    daemon.reads = () => Promise.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(connection.state().phase).toBe("disconnected");
    expect(daemon.openStream()).toBeUndefined();
  });

  it("a read that gives up after 10 seconds marks the console disconnected", async () => {
    const { connection, daemon, watch } = start(false);
    daemon.reads = () => Promise.reject(new RequestTimeoutError("/v1/workers"));
    watch("/v1/workers");
    await settle();

    expect(connection.state().phase).toBe("disconnected");
  });

  it("while the daemon is starting, a read that gives up is sent again rather than marking the console disconnected", async () => {
    const { connection, daemon, watch } = start(false);
    watch("/v1/workers");
    await settle();
    daemon.openStream()?.end();
    await settle();
    const givesUp = (path: ApiPath) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new RequestTimeoutError(path)), 10_000);
      });
    daemon.reads = givesUp;
    daemon.refuseStreams = () => givesUp("/v1/events/stream");
    const reads = daemon.gets.length;
    const streams = daemon.streams.length;

    await vi.advanceTimersByTimeAsync(21_000);

    expect(connection.state().phase).toBe("starting");
    expect(daemon.gets.length - reads).toBe(3);
    expect(daemon.streams.length - streams).toBe(3);
    expect(daemon.healthChecks).toHaveLength(1);
  });

  it("a loss while the stream opens leaves the next open saying how long it was closed", async () => {
    const { connection, daemon, watch } = start(false);
    watch("/v1/workers");
    await settle();
    const opened: { closedForMs?: number }[] = [];
    connection.onStreamOpened((event) => opened.push(event));
    daemon.openStream()?.end();
    await settle();
    let failRead: (error: unknown) => void = () => {};
    daemon.reads = () =>
      new Promise((_resolve, reject) => {
        failRead = reject;
      });
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.state().phase).toBe("starting");

    daemon.openHeldStreams();
    failRead(new TypeError("Failed to fetch"));
    await settle();
    expect(connection.state().phase).toBe("disconnected");
    expect(opened).toEqual([]);

    daemon.reads = "answer";
    daemon.holdStreams = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.state().phase).toBe("connected");
    expect(opened).toEqual([{ closedForMs: 2_000 }]);
  });

  it("nothing is asked while the tab is hidden: not a coalesced read, not /v1/healthz", async () => {
    const { connection, daemon, visibility, watch } = start(false);
    let failRead: (error: unknown) => void = () => {};
    daemon.reads = () =>
      new Promise((_resolve, reject) => {
        failRead = reject;
      });
    watch("/v1/workers");
    await settle();
    daemon.openStream()?.send(EVENT);
    await settle();
    visibility.set(true);
    await settle();
    const reads = daemon.gets.length;

    failRead(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connection.state().phase).toBe("disconnected");
    expect(daemon.gets).toHaveLength(reads);
    expect(daemon.healthChecks).toEqual([]);
  });

  it("a refused read keeps the data the console had and the console connected", async () => {
    const { connection, daemon, state, watch } = start();
    watch("/v1/workers");
    await settle();
    const before = state("/v1/workers").data;
    expect(before).toBeDefined();

    daemon.reads = () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state("/v1/workers")).toEqual({ data: before, error: expect.any(ApiError) });

    daemon.reads = () => Promise.reject(new SyntaxError("Unexpected token <"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state("/v1/workers").error).toBeInstanceOf(SyntaxError);
    expect(connection.state().phase).toBe("connected");
  });

  it("a daemon that is starting and refuses a read is ready", async () => {
    const { connection, daemon, watch } = start(false);
    watch("/v1/workers");
    await settle();
    daemon.openStream()?.end();
    await settle();
    daemon.reads = () => Promise.reject(new ApiError(501, "UNSUPPORTED_IN_WORKER_MODE", "No"));
    daemon.holdStreams = true;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.state().phase).toBe("connected");
  });

  it("the data's age is the time of the latest answer to a read", async () => {
    const { connection, daemon, watch } = start();
    watch("/v1/workers");
    await vi.advanceTimersByTimeAsync(15_000);
    const lastAnswer = Date.now();

    daemon.reads = () => Promise.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(connection.state()).toEqual({ answeredAt: lastAnswer, phase: "disconnected" });
  });

  it("durations use the clock offset from the latest Date header", async () => {
    const { connection, daemon, watch } = start();
    const browserNow = Date.now();
    watch("/v1/workers");
    daemon.date = new Date(browserNow + 15_000 + 90_000).toUTCString();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection.serverNow() - Date.now()).toBe(90_000);

    daemon.date = new Date(Date.now() + 15_000 - 30_000).toUTCString();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection.serverNow() - Date.now()).toBe(-30_000);
    daemon.date = "not a date";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection.serverNow() - Date.now()).toBe(-30_000);
  });
});

describe("a route's ETag", () => {
  it("a re-read of an unchanged route sends the first tag: a 304 keeps the same data object with no update, a 200 brings new data and its tag, a 304 after the data was dropped is read again without a tag", async () => {
    const { daemon, queries } = start();
    daemon.etag = '"v1"';
    const observer = new QueryObserver(queries.client, {
      ...queries.options("/v1/workers"),
      notifyOnChangeProps: ["data"],
    });
    const updates = vi.fn();
    disposers.push(observer.subscribe(updates));
    await settle();
    const first = observer.getCurrentResult().data;
    expect(first).toBeDefined();
    expect(daemon.gets.map((get) => get.tag)).toEqual([undefined]);
    updates.mockClear();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(daemon.gets.map((get) => get.tag)).toEqual([undefined, '"v1"']);
    expect(observer.getCurrentResult().data).toBe(first);
    expect(updates).not.toHaveBeenCalled();

    daemon.etag = '"v2"';
    await vi.advanceTimersByTimeAsync(15_000);
    const second = observer.getCurrentResult().data;
    expect(daemon.gets.map((get) => get.tag)).toEqual([undefined, '"v1"', '"v1"']);
    expect(second).not.toBe(first);
    expect(second).toEqual({ read: 3 });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(daemon.gets.map((get) => get.tag)).toEqual([undefined, '"v1"', '"v1"', '"v2"']);
    expect(observer.getCurrentResult().data).toBe(second);

    let release: () => void = () => {};
    daemon.reads = () =>
      new Promise((resolve) => {
        release = () => {
          daemon.reads = "answer";
          resolve({ date: null, notModified: true });
        };
      });
    await vi.advanceTimersByTimeAsync(15_000);
    queries.client.removeQueries({ queryKey: routeKey("/v1/workers") });
    release();
    await settle();

    expect(daemon.gets.map((get) => get.tag)).toEqual([
      undefined,
      '"v1"',
      '"v1"',
      '"v2"',
      '"v2"',
      undefined,
    ]);
  });
});
