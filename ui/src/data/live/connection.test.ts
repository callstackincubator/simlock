import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { connect, settle } from "./test-support";

const EVENT = 'event: lease.granted\ndata: {"seq":1,"timestamp":1,"event":"lease.granted"}\n\n';

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveConnection", () => {
  it("the stream closes while the tab is hidden and reopens when it is shown", async () => {
    const { connection, daemon, visibility } = connect();
    await settle();
    const stream = daemon.openStream();
    expect(stream).toBeDefined();

    visibility.set(true);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(stream?.closedByConsole()).toBe(true);
    expect(daemon.openStream()).toBeUndefined();

    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));
    visibility.set(false);
    await settle();
    expect(daemon.streams).toHaveLength(2);
    expect(daemon.openStream()).toBe(daemon.streams[1]);
    expect(opened).toEqual([5_000]);
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
    await settle();

    await vi.advanceTimersByTimeAsync(30_000);
    daemon.openStream()?.send(": keepalive\n\n");
    await vi.advanceTimersByTimeAsync(39_999);
    expect(connection.state().phase).toBe("connected");

    await vi.advanceTimersByTimeAsync(1);
    expect(connection.state().phase).toBe("disconnected");
  });

  it("a loss in a proxy session asks whether the session is still the proxy's before the backoff", async () => {
    for (const answer of ["reconnect", "backoff", "stop"] as const) {
      const asked: number[] = [];
      const { connection, daemon } = connect(() => {
        asked.push(Date.now());
        return Promise.resolve(answer);
      });
      await settle();
      const lostAt = Date.now();
      daemon.openStream()?.end();
      await settle();
      expect(asked).toEqual([lostAt]);

      await vi.advanceTimersByTimeAsync(1_000);

      const reopened = daemon.streams.length - 1;
      if (answer === "reconnect") {
        expect(reopened).toBe(1);
        expect(daemon.healthChecks).toEqual([]);
        expect(connection.state().phase).toBe("connected");
      } else if (answer === "backoff") {
        expect(daemon.healthChecks).toEqual([lostAt + 1_000]);
        expect(reopened).toBe(1);
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(daemon.healthChecks).toEqual([]);
        expect(reopened).toBe(0);
        expect(connection.state().phase).toBe("disconnected");
      }
      connection.dispose();
    }
  });

  it("an answer to reconnect that arrives after the tab was hidden or the connection disposed opens nothing", async () => {
    for (const end of ["hidden", "disposed"] as const) {
      let answer: (value: "reconnect") => void = () => {};
      const { connection, daemon, visibility } = connect(
        () => new Promise((resolve) => (answer = resolve)),
      );
      await settle();
      daemon.openStream()?.end();
      await settle();
      if (end === "hidden") visibility.set(true);
      else connection.dispose();
      const streams = daemon.streams.length;

      answer("reconnect");
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(daemon.streams).toHaveLength(streams);
      connection.dispose();
    }
  });

  it("a stream silent for 40 seconds in a proxy session reconnects at once when the proxy still knows the person", async () => {
    const { daemon } = connect(() => Promise.resolve("reconnect"));
    await settle();

    await vi.advanceTimersByTimeAsync(40_000);

    expect(daemon.streams).toHaveLength(2);
    expect(daemon.healthChecks).toEqual([]);
  });

  it("while disconnected, /v1/healthz is called after 1, 2, 4 and 8 seconds, then every 10", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.health = "down";
    daemon.openStream()?.end();
    await settle();
    const lostAt = Date.now();

    await vi.advanceTimersByTimeAsync(45_000);

    const offsets = daemon.healthChecks.map((at) => at - lostAt);
    expect(offsets).toEqual([1_000, 3_000, 7_000, 15_000, 25_000, 35_000, 45_000]);
    expect(daemon.streams).toHaveLength(1);
    expect(connection.state().phase).toBe("disconnected");
  });

  it("when /v1/healthz answers, the stream is reopened", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.health = "unreachable";
    daemon.openStream()?.end();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(connection.state().phase).toBe("disconnected");
    const phases: string[] = [];
    connection.subscribe(() => phases.push(connection.state().phase));
    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));

    daemon.health = "up";
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(connection.state().phase).toBe("starting");
    expect(daemon.streams).toHaveLength(2);

    daemon.openHeldStreams();
    await settle();
    expect(connection.state().phase).toBe("connected");
    expect(phases).toEqual(["starting", "connected"]);
    expect(daemon.openStream()).toBe(daemon.streams[1]);
    expect(opened).toEqual([7_000]);
  });

  it("a stream the console closes itself does not mark the console disconnected", async () => {
    const { connection, daemon, visibility } = connect();
    const events: unknown[] = [];
    connection.onEvent((event) => events.push(event));
    await settle();

    visibility.set(true);
    await settle();
    expect(connection.state().phase).toBe("connected");
    visibility.set(false);
    await settle();

    daemon.openStream()?.send(EVENT);
    visibility.set(true);
    await settle();
    expect(events).toEqual([]);
    expect(connection.state().phase).toBe("connected");

    daemon.holdStreams = true;
    visibility.set(false);
    await settle();
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(connection.state().phase).toBe("connected");
    expect(daemon.healthChecks).toEqual([]);
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
    await settle();
    daemon.openStream()?.end();
    await settle();
    daemon.holdStreams = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.state().phase).toBe("starting");

    daemon.openHeldStreams();
    await settle();

    expect(connection.state().phase).toBe("connected");
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
    await vi.advanceTimersByTimeAsync(3_000);
    expect(daemon.healthChecks.map((at) => at - shownAt)).toEqual([0, 1_000, 3_000]);
  });

  it("a refused stream leaves the console connected and is asked for again a second later", async () => {
    const { connection, daemon } = connect();
    await settle();
    daemon.refuseStreams = () => Promise.reject(new ApiError(503, "INTERNAL", "Busy"));
    daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(1_000);
    const streams = daemon.streams.length;
    daemon.refuseStreams = undefined;

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

  it("disposing the connection closes the stream and stops every timer", async () => {
    const { connection, daemon } = connect();
    await settle();
    const stream = daemon.openStream();

    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stream?.closedByConsole()).toBe(true);
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
});

describe("StreamOpened", () => {
  it("a stream that died without closing counts as closed from the last thing it sent", async () => {
    const { connection, daemon } = connect();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    daemon.openStream()?.send(": keepalive\n\n");
    await settle();
    const opened: (number | undefined)[] = [];
    connection.onStreamOpened((event) => opened.push(event.closedForMs));

    await vi.advanceTimersByTimeAsync(41_000);

    expect(connection.state().phase).toBe("connected");
    expect(opened).toEqual([41_000]);
  });
});
