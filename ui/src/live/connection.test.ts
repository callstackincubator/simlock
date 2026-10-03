import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, RequestTimeoutError } from "../api";
import type { StreamOpened } from "./connection";
import { connect, settle } from "./test-support";

const EVENT = 'event: lease.granted\ndata: {"seq":1,"timestamp":1,"event":"lease.granted"}\n\n';

afterEach(() => {
  vi.useRealTimers();
});

/** The paths read since `from`, in order. */
function readsSince(gets: readonly { readonly path: ApiPath }[], from: number): ApiPath[] {
  return gets.slice(from).map((get) => get.path);
}

describe("LiveConnection", () => {
  it("an event refetches the routes the current screen reads", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    connection.watch("/v1/leases", () => {});
    // A route a screen read before and no longer does.
    connection.watch("/v1/leases/l_1", () => {})();
    await settle();
    const before = daemon.gets.length;

    daemon.openStream()?.send(EVENT);
    await settle();

    expect(readsSince(daemon.gets, before)).toEqual(["/v1/workers", "/v1/leases"]);
    // At once: the clock has not moved, so no poll could have sent them.
    expect(daemon.gets.slice(before).every((get) => get.at === Date.now())).toBe(true);
  });

  it("a burst of events while a request is in flight causes exactly one more request", async () => {
    const { connection, daemon } = connect();
    daemon.reads = "hold";
    connection.watch("/v1/workers", () => {});
    await settle();
    expect(daemon.gets).toHaveLength(1);

    for (let event = 0; event < 5; event += 1) daemon.openStream()?.send(EVENT);
    await settle();
    expect(daemon.gets).toHaveLength(1);

    daemon.release();
    await settle();
    expect(daemon.gets).toHaveLength(2);

    daemon.release();
    await settle();
    expect(daemon.gets).toHaveLength(2);
  });

  it("the screen is refetched every second while the tab is visible", async () => {
    const { connection, daemon } = connect();
    const start = Date.now();
    connection.watch("/v1/workers", () => {});
    await settle();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(daemon.gets.map((get) => get.at - start)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000,
    ]);
  });

  it("polling stops and the stream closes while the tab is hidden, and both resume when it is shown", async () => {
    const { connection, daemon, visibility } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    const stream = daemon.openStream();
    expect(stream).toBeDefined();

    visibility.set(true);
    await settle();
    const hiddenAt = daemon.gets.length;
    // Not a poll that will find the tab hidden when it fires: no timer at all.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(stream?.closedByConsole()).toBe(true);
    expect(daemon.openStream()).toBeUndefined();
    expect(daemon.gets).toHaveLength(hiddenAt);

    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));
    visibility.set(false);
    await settle();
    // Shown: the screen at once, a new stream, and the poll again.
    expect(daemon.gets).toHaveLength(hiddenAt + 1);
    expect(daemon.streams).toHaveLength(2);
    expect(daemon.openStream()).toBe(daemon.streams[1]);
    expect(opened).toEqual([5_000]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(daemon.gets).toHaveLength(hiddenAt + 2);
  });

  it("a request that fails at the network level marks the console disconnected", async () => {
    const { connection, daemon } = connect();
    daemon.reads = () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error"));
    connection.watch("/v1/workers", () => {});
    await settle();
    // A refusal is the daemon answering: still connected, and the refusal is the route's.
    expect(connection.state().phase).toBe("connected");
    expect(connection.resource("/v1/workers").error).toBeInstanceOf(ApiError);

    daemon.reads = () => Promise.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.state().phase).toBe("disconnected");
    expect(daemon.openStream()).toBeUndefined();
  });

  it("a request that gives up after 10 seconds marks the console disconnected", async () => {
    const { connection, daemon } = connect();
    daemon.reads = () => Promise.reject(new RequestTimeoutError("/v1/workers"));
    connection.watch("/v1/workers", () => {});
    await settle();

    expect(connection.state().phase).toBe("disconnected");
  });

  it("a stream the daemon closes marks the console disconnected", async () => {
    const { connection, daemon } = connect();
    await settle();

    daemon.openStream()?.end();
    await settle();

    expect(connection.state().phase).toBe("disconnected");
  });

  it("a stream silent for 40 seconds marks the console disconnected", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();

    // A keepalive is not silence: it starts the 40 seconds again.
    await vi.advanceTimersByTimeAsync(30_000);
    daemon.openStream()?.send(": keepalive\n\n");
    await vi.advanceTimersByTimeAsync(39_999);
    expect(connection.state().phase).toBe("connected");

    await vi.advanceTimersByTimeAsync(1);
    expect(connection.state().phase).toBe("disconnected");
  });

  it("while disconnected, /v1/healthz is called after 1, 2, 4 and 8 seconds, then every 10", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    daemon.health = "down";
    daemon.openStream()?.end();
    await settle();
    const lostAt = Date.now();
    const reads = daemon.gets.length;

    await vi.advanceTimersByTimeAsync(45_000);

    const offsets = daemon.healthChecks.map((at) => at - lostAt);
    expect(offsets).toEqual([1_000, 3_000, 7_000, 15_000, 25_000, 35_000, 45_000]);
    // Nothing else is asked while disconnected: no poll, no stream.
    expect(daemon.gets).toHaveLength(reads);
    expect(daemon.streams).toHaveLength(1);
    expect(connection.state().phase).toBe("disconnected");
  });

  it("when /v1/healthz answers, the screen is refetched and the stream reopened", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    daemon.health = "unreachable";
    daemon.openStream()?.end();
    await settle();
    const reads = daemon.gets.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connection.state().phase).toBe("disconnected");
    const phases: string[] = [];
    connection.subscribe(() => phases.push(connection.state().phase));
    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));

    // A starting daemon answers /v1/healthz and holds its reads and its stream until it is ready.
    daemon.health = "up";
    daemon.reads = "hold";
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(connection.state().phase).toBe("starting");
    expect(readsSince(daemon.gets, reads)).toEqual(["/v1/workers"]);
    expect(daemon.streams).toHaveLength(2);

    daemon.release();
    await settle();
    expect(connection.state().phase).toBe("connected");
    expect(phases).toEqual(["starting", "connected"]);
    expect(daemon.openStream()).toBe(daemon.streams[1]);
    expect(opened).toEqual([7_000]);

    // And the poll is back.
    daemon.reads = "answer";
    const recovered = daemon.gets.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(daemon.gets).toHaveLength(recovered + 1);
  });

  it("while the daemon is starting, a request that gives up is sent again rather than marking the console disconnected", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    daemon.openStream()?.end();
    await settle();
    // A starting daemon holds both until each gives up, 10 seconds later.
    const givesUp = (path: ApiPath) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new RequestTimeoutError(path)), 10_000);
      });
    daemon.reads = givesUp;
    daemon.refuseStreams = () => givesUp("/v1/events/stream");
    const reads = daemon.gets.length;
    const streams = daemon.streams.length;

    // /v1/healthz answers after a second, then two rounds of giving up.
    await vi.advanceTimersByTimeAsync(21_000);

    expect(connection.state().phase).toBe("starting");
    expect(daemon.gets.length - reads).toBe(3);
    expect(daemon.streams.length - streams).toBe(3);
    expect(daemon.healthChecks).toHaveLength(1);
  });

  it("a stream the console closes itself does not mark the console disconnected", async () => {
    const { connection, daemon, visibility } = connect();
    const events: unknown[] = [];
    connection.onEvent((event) => events.push(event));
    await settle();

    // An open stream, idle, closed by hiding the tab.
    visibility.set(true);
    await settle();
    expect(connection.state().phase).toBe("connected");
    visibility.set(false);
    await settle();

    // An open stream, closed by hiding the tab, with an event already read off it.
    daemon.openStream()?.send(EVENT);
    visibility.set(true);
    await settle();
    expect(events).toEqual([]);
    expect(connection.state().phase).toBe("connected");

    // A stream whose headers have not arrived yet, closed the same way.
    daemon.holdStreams = true;
    visibility.set(false);
    await settle();
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connection.state().phase).toBe("connected");
    expect(daemon.healthChecks).toEqual([]);
  });

  it("a loss while the stream opens leaves the next open saying how long it was closed", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    const opened: StreamOpened[] = [];
    connection.onStreamOpened((event) => opened.push(event));
    daemon.openStream()?.end();
    await settle();
    // Recovering: the stream's headers and the screen's read are both held.
    let failRead: (error: unknown) => void = () => {};
    daemon.reads = () =>
      new Promise((_resolve, reject) => {
        failRead = reject;
      });
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.state().phase).toBe("starting");

    // The headers arrive, and in the same moment the read fails at the network level.
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

  it("each loss starts the /v1/healthz backoff from 1 second again", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.health = "down";
    daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(daemon.healthChecks).toHaveLength(4);
    daemon.health = "up";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.state().phase).toBe("connected");

    daemon.health = "down";
    daemon.openStream()?.end();
    await settle();
    const lostAt = Date.now();
    const before = daemon.healthChecks.length;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(daemon.healthChecks.slice(before).map((at) => at - lostAt)).toEqual([1_000, 3_000]);
  });

  it("a daemon that is starting is ready once it opens the stream", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    daemon.openStream()?.end();
    await settle();
    daemon.reads = "hold";
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.state().phase).toBe("starting");

    daemon.openHeldStreams();
    await settle();

    expect(connection.state().phase).toBe("connected");
  });

  it("nothing is asked while the tab is hidden: not a coalesced read, not /v1/healthz", async () => {
    const { connection, daemon, visibility } = connect();
    let failRead: (error: unknown) => void = () => {};
    daemon.reads = () =>
      new Promise((_resolve, reject) => {
        failRead = reject;
      });
    connection.watch("/v1/workers", () => {});
    await settle();
    // An event while the read is in flight asks for one more read after it.
    daemon.openStream()?.send(EVENT);
    await settle();
    visibility.set(true);
    await settle();
    const reads = daemon.gets.length;

    // The read fails while the tab is hidden: lost, but nothing more is asked.
    failRead(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(connection.state().phase).toBe("disconnected");
    expect(daemon.gets).toHaveLength(reads);
    expect(daemon.healthChecks).toEqual([]);
  });

  it("a tab shown again while disconnected asks /v1/healthz at once", async () => {
    const { connection, daemon, visibility } = connect();
    await settle();
    daemon.health = "down";
    daemon.openStream()?.end();
    await settle();
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(daemon.healthChecks).toEqual([]);

    visibility.set(false);
    await settle();
    const shownAt = Date.now();

    expect(daemon.healthChecks).toEqual([shownAt]);
    expect(connection.state().phase).toBe("disconnected");
    // And the backoff starts again from 1 second.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(daemon.healthChecks.map((at) => at - shownAt)).toEqual([0, 1_000, 3_000]);
  });

  it("a refused read keeps the data the console had and the console connected", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    const before = connection.resource("/v1/workers").data;
    expect(before).toBeDefined();

    daemon.reads = () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.resource("/v1/workers")).toEqual({
      data: before,
      error: expect.any(ApiError),
    });

    // A body that is not JSON is the daemon answering too.
    daemon.reads = () => Promise.reject(new SyntaxError("Unexpected token <"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.resource("/v1/workers").error).toBeInstanceOf(SyntaxError);
    expect(connection.state().phase).toBe("connected");
  });

  it("a daemon that is starting and refuses a read is ready", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    daemon.openStream()?.end();
    await settle();
    daemon.reads = () => Promise.reject(new ApiError(501, "UNSUPPORTED_IN_WORKER_MODE", "No"));
    daemon.holdStreams = true;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.state().phase).toBe("connected");
  });

  it("a refused stream leaves the console connected and is asked for again with the next poll", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.refuseStreams = () => Promise.reject(new ApiError(503, "INTERNAL", "Busy"));
    daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(1_000);
    const streams = daemon.streams.length;
    daemon.refuseStreams = undefined;

    // Recovery opened one and it was refused; the console is back, and the poll asks again.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.state().phase).toBe("connected");
    expect(daemon.streams).toHaveLength(streams + 1);
    expect(daemon.openStream()).toBe(daemon.streams.at(-1));
  });

  it("a stream that breaks mid-read marks the console disconnected", async () => {
    const { connection, daemon } = connect();
    await settle();

    daemon.openStream()?.break();
    await settle();

    expect(connection.state().phase).toBe("disconnected");
  });

  it("every event reaches the event listeners, its data parsed", async () => {
    const { connection, daemon } = connect();
    const events: unknown[] = [];
    connection.onEvent((event) => events.push(event));
    await settle();

    daemon.openStream()?.send(EVENT);
    daemon.openStream()?.send("event: odd\ndata: not json\n\n");
    await settle();

    expect(events).toEqual([
      { data: { event: "lease.granted", seq: 1, timestamp: 1 }, event: "lease.granted" },
      { data: undefined, event: "odd" },
    ]);
  });

  it("the data's age is the time of the latest answer to a read", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await vi.advanceTimersByTimeAsync(3_000);
    const lastAnswer = Date.now();

    daemon.reads = () => Promise.reject(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connection.state()).toEqual({ answeredAt: lastAnswer, phase: "disconnected" });
  });

  it("disposing the connection closes the stream and stops every timer", async () => {
    const { connection, daemon } = connect();
    connection.watch("/v1/workers", () => {});
    await settle();
    const stream = daemon.openStream();
    const reads = daemon.gets.length;

    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stream?.closedByConsole()).toBe(true);
    expect(daemon.gets).toHaveLength(reads);
    expect(daemon.healthChecks).toEqual([]);
  });

  it("disposing a disconnected connection stops its health checks", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.health = "down";
    daemon.openStream()?.end();
    await settle();

    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(daemon.healthChecks).toEqual([]);
  });

  it("durations use the clock offset from the latest Date header", async () => {
    const { connection, daemon } = connect();
    const browserNow = Date.now();
    connection.watch("/v1/workers", () => {});
    // Sent with the next poll's answer, one second from now.
    daemon.date = new Date(browserNow + 1_000 + 90_000).toUTCString();
    await vi.advanceTimersByTimeAsync(1_000);
    // The daemon's clock is 90 seconds ahead of the browser's.
    expect(connection.serverNow() - Date.now()).toBe(90_000);

    // The latest header wins, and a header that is not a date changes nothing.
    daemon.date = new Date(Date.now() + 1_000 - 30_000).toUTCString();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.serverNow() - Date.now()).toBe(-30_000);
    daemon.date = "not a date";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.serverNow() - Date.now()).toBe(-30_000);
  });
});

describe("StreamOpened", () => {
  it("a stream that died without closing counts as closed from the last thing it sent", async () => {
    const { connection, daemon } = connect();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    // The daemon's keepalive, then nothing: the stream is dead and the console does not know yet.
    daemon.openStream()?.send(": keepalive\n\n");
    await settle();
    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));

    // 40 seconds of silence mark the console disconnected; /v1/healthz answers 1 second later.
    await vi.advanceTimersByTimeAsync(41_000);

    expect(connection.state().phase).toBe("connected");
    expect(opened).toEqual([41_000]);
  });
});
