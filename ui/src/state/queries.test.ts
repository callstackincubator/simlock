import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, RequestTimeoutError } from "../data/api";
import { connect, fakeClock, settle } from "../data/live/test-support";
import { createQueries, type Queries, resourceOf, routeKey } from "./queries";

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
      ["/v1/inbox", 10_000],
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

describe("data no page uses", () => {
  it("is dropped a minute after the last page using it closes", async () => {
    // why: each row is path, ms away, whether a read is sent again, whether the kept data shows at once.
    const cases = [
      ["/v1/workers", 1_999, false, true],
      ["/v1/workers", 2_000, true, true],
      ["/v1/workers", 59_999, true, true],
      ["/v1/workers", 60_000, true, false],
      ["/v1/stats?since=1h", 29_999, false, true],
      ["/v1/stats?since=1h", 30_000, true, true],
      ["/v1/tokens", 59_999, false, true],
      ["/v1/tokens", 60_000, true, false],
    ] as const;
    for (const [path, gone, rereads, keptAtOnce] of cases) {
      const { queries, reads, watch } = start();
      const leave = watch(path);
      await settle();
      expect(reads(path)).toBe(1);
      leave();

      await vi.advanceTimersByTimeAsync(gone);
      const observer = new QueryObserver(queries.client, queries.options(path));
      const label = `${path} back after ${gone} ms`;
      expect(observer.getCurrentResult().data !== undefined, `${label}: data at once`).toBe(
        keptAtOnce,
      );
      observer.subscribe(() => undefined);
      await settle();
      expect(reads(path), `${label}: reads`).toBe(rereads ? 2 : 1);
      expect(observer.getCurrentResult().data, `${label}: data after the read`).toEqual({
        read: rereads ? 2 : 1,
      });
    }
  });
});

function send(
  daemon: ReturnType<typeof start>["daemon"],
  name: string,
  payload: Record<string, unknown> = {},
): void {
  const data = JSON.stringify({ event: name, payload, seq: 1, timestamp: 1 });
  daemon.openStream()?.send(`event: ${name}\ndata: ${data}\n\n`);
}

describe("events mark keys stale", () => {
  it("per the map, in bursts", async () => {
    const LEASES: ApiPath[] = ["/v1/leases", "/v1/leases/l_1", "/v1/leases/l_2"];
    const WATCHED = [
      ...LEASES,
      "/v1/lease-requests",
      "/v1/workers",
      "/v1/inbox",
      "/v1/stats?since=1h",
      "/v1/tokens",
    ] as const;
    // why: each row is an event, its payload, and exactly the routes it marks.
    const rows: readonly (readonly [string, Record<string, unknown>, readonly string[]])[] = [
      ["lease.granted", {}, [...LEASES, "/v1/workers", "/v1/inbox"]],
      ["lease.released", {}, [...LEASES, "/v1/workers", "/v1/inbox"]],
      ["lease.expired", {}, [...LEASES, "/v1/workers", "/v1/inbox"]],
      ["lease.requested", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["lease.queued", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["lease.rejected", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["lease.declined", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["request.granted", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["request.dispatched", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["queue.changed", {}, ["/v1/lease-requests", "/v1/inbox"]],
      ["lease.renewed", { leaseId: "l_1" }, []],
      ["device.ready", {}, ["/v1/workers", "/v1/inbox"]],
      ["device.quarantined", { leaseId: "l_1" }, ["/v1/workers", "/v1/inbox", ...LEASES.slice(1)]],
      ["worker.connected", {}, ["/v1/workers", "/v1/inbox"]],
      ["worker.drain-started", {}, ["/v1/workers", "/v1/inbox"]],
      ["capacity.changed", {}, ["/v1/workers", "/v1/inbox"]],
      ["component.installed", {}, ["/v1/workers", "/v1/inbox"]],
      ["daemon.update-started", {}, ["/v1/workers", "/v1/inbox"]],
      ["disk.pressure-detected", {}, []],
      ["lease.something-new", {}, []],
    ];
    for (const [name, payload, marked] of rows) {
      const { daemon, watch } = start();
      for (const path of WATCHED) watch(path);
      await settle();
      const before = daemon.gets.length;

      send(daemon, name, payload);
      await vi.advanceTimersByTimeAsync(300);

      expect(
        daemon.gets
          .slice(before)
          .map((get) => get.path)
          .sort(),
        name,
      ).toEqual([...marked].sort());
    }

    const burst = start();
    burst.watch("/v1/workers");
    await settle();
    for (let event = 0; event < 50; event += 1) {
      send(burst.daemon, "lease.granted");
      await vi.advanceTimersByTimeAsync(4);
    }
    await vi.advanceTimersByTimeAsync(295);
    expect(burst.reads("/v1/workers"), "300 ms after the last of 50 events, just before").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(burst.reads("/v1/workers"), "300 ms after the last of 50 events").toBe(2);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(burst.reads("/v1/workers"), "1.5 s later, just before").toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(burst.reads("/v1/workers"), "1.5 s later").toBe(3);

    const steady = start();
    steady.watch("/v1/workers");
    await settle();
    for (let event = 0; event < 4; event += 1) {
      send(steady.daemon, "lease.granted");
      await vi.advanceTimersByTimeAsync(200);
    }
    send(steady.daemon, "lease.granted");
    await vi.advanceTimersByTimeAsync(199);
    expect(steady.reads("/v1/workers"), "events every 200 ms, just before 1 s").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(steady.reads("/v1/workers"), "events every 200 ms, 1 s after the first").toBe(2);

    const away = start();
    away.watch("/v1/workers");
    away.watch("/v1/leases")();
    await settle();
    send(away.daemon, "lease.granted");
    await vi.advanceTimersByTimeAsync(1_900);
    expect(away.reads("/v1/leases"), "a key no page shows is not read").toBe(1);
    away.watch("/v1/leases");
    await settle();
    expect(away.reads("/v1/leases"), "and is read once a page shows it").toBe(2);
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

  it("a read lost to the network leaves the page its data, or its loading, and no error", async () => {
    const lost = () => Promise.reject(new TypeError("Failed to fetch"));
    const refused = () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error"));
    for (const [fails, error] of [
      [refused, expect.any(ApiError)],
      [lost, undefined],
    ] as const) {
      const { connection, daemon, queries } = start(false);
      const observer = new QueryObserver(queries.client, queries.options<unknown>("/v1/workers"));
      observer.subscribe(() => undefined);
      await settle();
      expect(resourceOf(observer.getCurrentResult())).toEqual({ data: { read: 1 } });

      daemon.reads = fails;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(resourceOf(observer.getCurrentResult())).toEqual({
        data: { read: 1 },
        ...(error === undefined ? {} : { error }),
      });
      expect(connection.state().phase).toBe(error === undefined ? "disconnected" : "connected");
    }

    const { daemon, queries } = start(false);
    daemon.reads = lost;
    const observer = new QueryObserver(queries.client, queries.options<unknown>("/v1/workers"));
    observer.subscribe(() => undefined);
    await settle();
    expect(resourceOf(observer.getCurrentResult())).toEqual({});
  });

  it("a read that times out marks the console disconnected", async () => {
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

  it("an event just before the tab hides reads nothing while it is hidden, at the burst or after it", async () => {
    const { daemon, reads, visibility, watch } = start();
    watch("/v1/workers");
    await settle();
    daemon.openStream()?.send(EVENT);
    await vi.advanceTimersByTimeAsync(100);
    visibility.set(true);
    const before = reads("/v1/workers");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(reads("/v1/workers")).toBe(before);
  });

  it("a read held while the tab is hidden and the daemon starts leaves the page no error", async () => {
    const { daemon, queries, visibility } = start(false);
    const observer = new QueryObserver(queries.client, queries.options<unknown>("/v1/workers"));
    observer.subscribe(() => undefined);
    await settle();
    daemon.openStream()?.end();
    await settle();
    daemon.reads = (path) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new RequestTimeoutError(path)), 10_000);
      });
    daemon.refuseStreams = () => new Promise<never>(() => undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(15_000);
    visibility.set(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(resourceOf(observer.getCurrentResult())).toEqual({ data: { read: 1 } });
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

describe("a lease renewal", () => {
  const NOW = Date.parse("2026-10-02T12:00:00Z");
  const lease = (id: string, over: Record<string, unknown> = {}) => ({
    deviceId: `dev_${id}`,
    grantedAt: NOW,
    id,
    idChosenByRequester: false,
    lastRenewedAt: NOW,
    ownerId: "owner",
    requesterId: "agent",
    ttlDeadline: NOW + 60_000,
    ttlMs: 60_000,
    ...over,
  });
  const renewed = (payload: Record<string, unknown>, seq = 2) =>
    `event: lease.renewed\ndata: ${JSON.stringify({
      event: "lease.renewed",
      id: `evt_${String(seq)}`,
      payload,
      seq,
      timestamp: Date.now(),
    })}\n\n`;

  it("moves the lease's deadline in place with no read: a worker event matches by id, a gateway event by worker and the worker's lease id in both lists, lastRenewedAt and ttlMs follow, a later answer with the old deadline keeps the new one for 60 seconds and one with a later deadline wins, no match or a malformed payload changes nothing", async () => {
    const { daemon, reads, state, watch } = start();
    daemon.reads = () =>
      Promise.resolve({ body: { leases: [lease("l_1"), lease("l_2")] }, date: null });
    watch("/v1/leases");
    await settle();
    const before = state("/v1/leases").data as { leases: object[] };

    await vi.advanceTimersByTimeAsync(5_000);
    const newDeadline = Date.now() + 120_000;
    daemon.openStream()?.send(renewed({ leaseId: "l_1", newDeadline }));
    await settle();

    const after = state("/v1/leases").data as { leases: object[] };
    expect(after.leases[0]).toEqual(
      lease("l_1", { lastRenewedAt: Date.now(), ttlDeadline: newDeadline, ttlMs: 120_000 }),
    );
    expect(after.leases[1]).toBe(before.leases[1]);
    expect(reads("/v1/leases")).toBe(1);

    daemon.openStream()?.send(renewed({ leaseId: "l_9", newDeadline: newDeadline + 1_000 }, 3));
    await settle();
    expect(state("/v1/leases").data).toBe(after);
    expect(reads("/v1/leases")).toBe(1);

    daemon.openStream()?.send(renewed({ leaseId: "l_2", newDeadline: "soon" }, 5));
    await settle();
    expect(state("/v1/leases").data).toBe(after);

    // why: a renewal, matched or not, is no read, so it leaves the poll's schedule alone.
    const readsBefore = reads("/v1/leases");
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      daemon
        .openStream()
        ?.send(
          renewed(
            { leaseId: tick % 2 === 0 ? "l_9" : "l_1", newDeadline: Date.now() + 120_000 },
            10 + tick,
          ),
        );
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      reads("/v1/leases") - readsBefore,
      "polls at 10, 20 and 30 s through renewals every 5 s, listed and unlisted",
    ).toBe(3);

    const gateway = start();
    const old = {
      leases: [
        lease("w1.l_1", { workerId: "w1", workerLeaseId: "l_1" }),
        lease("w1.l_2", { workerId: "w1", workerLeaseId: "l_2" }),
        lease("w2.l_1", { workerId: "w2", workerLeaseId: "l_1" }),
      ],
    };
    const fleet = {
      workers: [
        { id: "w1", leases: [lease("l_1"), lease("l_2")] },
        { id: "w2", leases: [lease("l_1")] },
      ],
    };
    gateway.daemon.reads = (path) =>
      Promise.resolve({ body: path === "/v1/leases" ? old : fleet, date: null });
    gateway.watch("/v1/leases");
    gateway.watch("/v1/workers");
    await settle();
    // why: polls land 9_999 ms after the renewal, so the checks below straddle its 60 s.
    await vi.advanceTimersByTimeAsync(1);
    const deadline = Date.now() + 120_000;
    gateway.daemon
      .openStream()
      ?.send(renewed({ leaseId: "l_1", newDeadline: deadline, workerId: "w1" }, 4));
    await settle();

    const moved = { lastRenewedAt: Date.now(), ttlDeadline: deadline, ttlMs: 120_000 };
    expect(gateway.state("/v1/leases").data).toEqual({
      leases: [
        lease("w1.l_1", { ...moved, workerId: "w1", workerLeaseId: "l_1" }),
        old.leases[1],
        old.leases[2],
      ],
    });
    expect(gateway.state("/v1/workers").data).toEqual({
      workers: [{ id: "w1", leases: [lease("l_1", moved), lease("l_2")] }, fleet.workers[1]],
    });
    expect(gateway.reads("/v1/leases") + gateway.reads("/v1/workers")).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateway.reads("/v1/leases")).toBe(2);
    const kept = gateway.state("/v1/leases").data as { leases: { ttlDeadline: number }[] };
    expect(kept.leases[0]?.ttlDeadline).toBe(deadline);
    expect(kept.leases[1]?.ttlDeadline).toBe(NOW + 60_000);

    const later = deadline + 5_000;
    gateway.daemon.reads = (path) =>
      Promise.resolve({
        body:
          path === "/v1/leases"
            ? { leases: [{ ...old.leases[0], ttlDeadline: later }, ...old.leases.slice(1)] }
            : fleet,
        date: null,
      });
    await vi.advanceTimersByTimeAsync(10_000);
    const newer = gateway.state("/v1/leases").data as { leases: { ttlDeadline: number }[] };
    expect(newer.leases[0]?.ttlDeadline).toBe(later);

    gateway.daemon.reads = (path) =>
      Promise.resolve({ body: path === "/v1/leases" ? old : fleet, date: null });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(9_999);
    const still = gateway.state("/v1/leases").data as { leases: { ttlDeadline: number }[] };
    expect(still.leases[0]?.ttlDeadline).toBe(deadline);

    await vi.advanceTimersByTimeAsync(10_000);
    const dropped = gateway.state("/v1/leases").data as { leases: { ttlDeadline: number }[] };
    expect(dropped.leases[0]?.ttlDeadline).toBe(NOW + 60_000);
  });
  it("marks only what a renewal leaves stale: 20 renewals of ending leases in 1 s give one inbox read, a lease observed gives one read, otherwise no request", async () => {
    const ending = { condition: "ending", group: "Heads-up", key: "lease/l_1/ending" };
    const inbox = { items: [{ ...ending, lease: lease("l_1") }] };
    const cases = [
      ["an ending lease in the inbox", "/v1/inbox", "l_1", 20, ["/v1/inbox"]],
      ["a lease whose page is open", "/v1/leases/l_1", "l_1", 20, ["/v1/leases/l_1"]],
      ["a lease nothing shows", "/v1/inbox", "l_2", 20, []],
      ["another lease's page", "/v1/leases/l_1", "l_2", 20, []],
      ["a gateway lease's page", "/v1/leases/w1.l_1", "l_1", 20, ["/v1/leases/w1.l_1"]],
      [
        "a gateway lease its requester named, whose page has no worker prefix",
        "/v1/leases/my-lease",
        "my-lease",
        20,
        ["/v1/leases/my-lease"],
      ],
    ] as const;
    for (const [label, path, leaseId, count, expected] of cases) {
      const { daemon, watch } = start();
      const listed = { leases: [lease("my-lease", { workerId: "w1", workerLeaseId: "my-lease" })] };
      daemon.reads = (read) =>
        Promise.resolve({
          body: read === "/v1/inbox" ? inbox : read === "/v1/leases" ? listed : {},
          date: null,
        });
      watch("/v1/leases");
      watch(path);
      await settle();
      const before = daemon.gets.length;

      for (let renewal = 0; renewal < count; renewal += 1) {
        daemon.openStream()?.send(
          renewed(
            {
              leaseId,
              newDeadline: Date.now() + 120_000 + renewal,
              ...(path.includes("w1.") || path.includes("my-lease") ? { workerId: "w1" } : {}),
            },
            renewal + 2,
          ),
        );
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.advanceTimersByTimeAsync(300);

      expect(
        daemon.gets.slice(before).map((get) => get.path),
        label,
      ).toEqual(expected);
    }
  });
});
