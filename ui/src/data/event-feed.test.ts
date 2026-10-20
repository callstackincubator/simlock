import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, type ApiResponse } from "./api";
import type { Clock } from "./live/connection";
import { connect, settle } from "./live/test-support";
import { EventFeed } from "./event-feed";
import { MAX_EVENTS } from "../model/events";

const T0 = Date.parse("2026-10-02T11:30:00Z");

const fakeClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function envelope(
  seq: number,
  timestamp: number,
  event = "lease.granted",
  payload: unknown = {},
  id = `evt_${seq}_${timestamp}`,
) {
  return { event, id, module: "lease", payload, seq, timestamp };
}

function frame(event: ReturnType<typeof envelope>): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

type Replay = unknown[] | ((path: ApiPath) => Promise<unknown>);

function eventLog(
  events: readonly ReturnType<typeof envelope>[],
): (path: ApiPath) => Promise<unknown> {
  return (path) => {
    const match = /since=(\d+)(s|h)$/.exec(path);
    if (match === null) throw new Error(`Unexpected path ${path}`);
    const ms = Number(match[1]) * (match[2] === "h" ? 3_600_000 : 1_000);
    return Promise.resolve({ events: events.filter((event) => event.timestamp > Date.now() - ms) });
  };
}

function openView(first: Replay = [], showsHistory = false) {
  const live = connect();
  const replays: ApiPath[] = [];
  const olderReads: ApiPath[] = [];
  let replay: Replay = first;
  live.daemon.reads = async (path) => {
    if (!path.startsWith("/v1/events?")) return { body: {}, date: null };
    if (!path.includes("since=")) {
      olderReads.push(path);
      return {
        body: typeof replay === "function" ? await replay(path) : { events: [] },
        date: null,
      };
    }
    replays.push(path);
    const body = typeof replay === "function" ? await replay(path) : { events: replay };
    return { body, date: null } satisfies ApiResponse<unknown>;
  };
  const feed = new EventFeed(
    async (path) => (await live.daemon.get(path)).body,
    fakeClock,
    showsHistory,
  );
  live.connection.onEvent(feed.streamEvent);
  live.connection.onStreamOpened(feed.streamOpened);
  const stop = feed.start();
  return {
    ...live,
    feed,
    olderReads,
    replays,
    stop,
    replayWith(next: Replay) {
      replay = next;
    },
    ids(): string[] {
      return (feed.snapshot().data ?? []).map((event) => event.id);
    },
    shown(): string[] {
      return (feed.snapshot().data ?? []).map((event) => `${event.seq}@${event.timestamp}`);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the event feed", () => {
  it("the feed lists events from the stream and from the replay once each", async () => {
    const view = openView();
    view.replayWith([envelope(1, T0), envelope(2, T0 + 1_000)]);
    await settle();

    view.daemon.openStream()?.send(frame(envelope(3, T0 + 2_000)));
    view.daemon.openStream()?.send(frame(envelope(4, T0 + 3_000)));
    await settle();

    expect(view.shown()).toEqual([
      `4@${T0 + 3_000}`,
      `3@${T0 + 2_000}`,
      `2@${T0 + 1_000}`,
      `1@${T0}`,
    ]);
  });

  it("an event in both the replay and the stream is shown once", async () => {
    const view = openView();
    const both = envelope(7, T0);
    view.daemon.openStream()?.send(frame(both));
    view.replayWith([envelope(6, T0 - 1_000), both]);
    await settle();
    expect(view.shown()).toEqual([`7@${T0}`, `6@${T0 - 1_000}`]);

    view.daemon.openStream()?.send(frame(both));
    await settle();

    expect(view.shown()).toEqual([`7@${T0}`, `6@${T0 - 1_000}`]);
  });

  it("two events with the same seq and timestamp but different ids are both shown", async () => {
    const view = openView();
    view.replayWith([envelope(1, T0, "lease.granted", {}, "evt_a")]);
    await settle();

    view.daemon.openStream()?.send(frame(envelope(1, T0, "lease.granted", {}, "evt_b")));
    await settle();

    expect(view.ids().sort()).toEqual(["evt_a", "evt_b"]);
  });

  it("events with the same timestamp are listed by seq, newest first", async () => {
    const view = openView();
    view.replayWith([envelope(2, T0), envelope(9, T0), envelope(5, T0)]);
    await settle();

    expect(view.shown()).toEqual([`9@${T0}`, `5@${T0}`, `2@${T0}`]);
  });

  it("an envelope without an id is not shown", async () => {
    const view = openView();
    const { id: _id, ...withoutId } = envelope(2, T0);
    view.replayWith([withoutId, { ...envelope(3, T0), id: 3 }, envelope(4, T0)]);
    await settle();

    expect(view.ids()).toEqual(["evt_4_" + T0]);
  });

  it("events with the same seq from before and after a daemon restart are both shown", async () => {
    const view = openView();
    await settle();
    const before = envelope(1, T0, "daemon.started");
    view.daemon.openStream()?.send(frame(before));
    await settle();

    view.daemon.openStream()?.end();
    await settle();
    const after = envelope(1, T0 + 5_000, "daemon.started");
    view.replayWith([before, after]);
    await vi.advanceTimersByTimeAsync(1_000);
    view.daemon.openStream()?.send(frame(after));
    await settle();

    expect(view.shown()).toEqual([`1@${T0 + 5_000}`, `1@${T0}`]);
  });

  it("after a reconnect the gap is filled from GET /v1/events with since rounded up to whole seconds", async () => {
    const view = openView();
    await settle();
    expect(view.replays).toEqual(["/v1/events?since=1h", "/v1/events?since=1h"]);

    view.daemon.holdStreams = true;
    view.daemon.openStream()?.end();
    await settle();
    const missed = envelope(1, Date.now() + 500, "daemon.started");
    view.replayWith([missed]);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(view.replays).toHaveLength(2);
    view.daemon.openHeldStreams();
    await settle();

    expect(view.replays.slice(2)).toEqual(["/v1/events?since=2s"]);
    expect(view.shown()).toEqual([`1@${missed.timestamp}`]);
  });

  it("after a hidden tab is shown again the gap is filled the same way", async () => {
    const view = openView();
    await settle();

    view.visibility.set(true);
    await vi.advanceTimersByTimeAsync(4_001);
    const missed = envelope(5, Date.now() - 2_000);
    view.replayWith([missed]);
    view.visibility.set(false);
    await settle();

    expect(view.replays.slice(2)).toEqual(["/v1/events?since=5s"]);
    expect(view.shown()).toEqual([`5@${missed.timestamp}`]);
  });

  it("a feed opened before the stream loads the recent events again once the stream opens", async () => {
    const view = openView();
    expect(view.replays).toEqual(["/v1/events?since=1h"]);
    const sentBetween = envelope(9, T0);
    view.replayWith([sentBetween]);
    await settle();

    expect(view.replays).toEqual(["/v1/events?since=1h", "/v1/events?since=1h"]);
    expect(view.shown()).toEqual([`9@${T0}`]);
  });

  it("a stream that first opens after the last hour loaded loads it again", async () => {
    const view = openView([]);
    await settle();
    const sent = view.replays.length;
    view.replayWith([envelope(1, T0)]);

    view.feed.streamOpened({});
    await settle();

    expect(view.replays.slice(sent)).toEqual(["/v1/events?since=1h"]);
    expect(view.shown()).toEqual([`1@${T0}`]);
  });

  it("the feed keeps the newest 10,000 events", async () => {
    expect(MAX_EVENTS).toBe(10_000);
    const view = openView();
    view.replayWith(
      Array.from({ length: MAX_EVENTS }, (_, index) => envelope(index + 1, T0 + index * 1_000)),
    );
    await settle();
    expect(view.shown()).toHaveLength(MAX_EVENTS);

    view.daemon.openStream()?.send(frame(envelope(MAX_EVENTS + 1, T0 + MAX_EVENTS * 1_000)));
    view.daemon.openStream()?.send(frame(envelope(0, T0 - 1_000)));
    await settle();

    const shown = view.shown();
    expect(shown).toHaveLength(MAX_EVENTS);
    expect(shown[0]).toBe(`${MAX_EVENTS + 1}@${T0 + MAX_EVENTS * 1_000}`);
    expect(shown.at(-1)).toBe(`2@${T0 + 1_000}`);
  });

  it("an envelope without a numeric seq, a timestamp that is a date, or a name is not shown", async () => {
    const view = openView();
    view.replayWith([
      { event: "lease.granted", id: "evt_a", timestamp: T0 },
      { event: "lease.granted", id: "evt_b", seq: 1 },
      { id: "evt_c", seq: 2, timestamp: T0 },
      { event: "lease.granted", id: "evt_d", seq: 3, timestamp: 1e300 },
      { event: "lease.granted", id: "evt_e", seq: 5, timestamp: "2026-10-02T11:30:00Z" },
      { event: "lease.granted", id: "evt_f", seq: "6", timestamp: T0 },
      { event: 7, id: "evt_g", seq: 7, timestamp: T0 },
      envelope(4, T0),
    ]);
    await settle();

    expect(view.shown()).toEqual([`4@${T0}`]);
  });

  it("until the first load answers, the feed holds nothing yet", async () => {
    let answer: (body: unknown) => void = () => {};
    const view = openView(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await settle();
    view.daemon.openStream()?.send(frame(envelope(2, T0)));
    await settle();
    expect(view.feed.snapshot()).toEqual({});

    answer({ events: [envelope(1, T0 - 1_000)] });
    await settle();

    expect(view.shown()).toEqual([`2@${T0}`, `1@${T0 - 1_000}`]);
  });

  it("a load the daemon refuses shows why, and keeps the events already shown", async () => {
    const view = openView();
    view.replayWith([envelope(1, T0)]);
    await settle();
    expect(view.feed.snapshot().error).toBeUndefined();

    const refusal = new ApiError(500, "INTERNAL", "Internal error");
    view.replayWith(() => Promise.reject(refusal));
    view.visibility.set(true);
    view.visibility.set(false);
    await settle();

    expect(view.feed.snapshot().error).toBe(refusal);
    expect(view.shown()).toEqual([`1@${T0}`]);

    view.replayWith([envelope(2, T0 + 1_000)]);
    view.visibility.set(true);
    view.visibility.set(false);
    await settle();

    expect(view.feed.snapshot().error).toBeUndefined();
    expect(view.shown()).toEqual([`2@${T0 + 1_000}`, `1@${T0}`]);
  });

  it("an answer with no events list is refused as unreadable", async () => {
    const view = openView(() => Promise.resolve({ items: [envelope(1, T0)] }));
    await settle();

    const { data, error } = view.feed.snapshot();
    expect(error).toBeInstanceOf(SyntaxError);
    expect(data).toEqual([]);
  });

  it("a feed opened while the daemon is away loads the last hour once it is back", async () => {
    const view = openView(() => Promise.reject(new TypeError("Failed to fetch")));
    view.daemon.health = "unreachable";
    await settle();
    view.daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(view.connection.state().phase).toBe("disconnected");
    expect(view.feed.snapshot()).toEqual({});

    const earlier = envelope(1, Date.now() - 30 * 60_000);
    view.replayWith(eventLog([earlier]));
    view.daemon.health = "up";
    await vi.advanceTimersByTimeAsync(8_000);
    expect(view.connection.state().phase).toBe("connected");

    expect(view.shown()).toEqual([`1@${earlier.timestamp}`]);
  });

  it("a closed feed ignores what arrives after", async () => {
    let answer: (body: unknown) => void = () => {};
    let loads = 0;
    const view = openView(() => {
      loads += 1;
      if (loads === 1) return Promise.resolve({ events: [envelope(1, T0 - 1_000)] });
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    await settle();
    const before = view.feed.snapshot();
    expect(view.shown()).toEqual([`1@${T0 - 1_000}`]);

    view.stop();
    view.daemon.openStream()?.send(frame(envelope(2, T0)));
    answer({ events: [envelope(3, T0 + 1_000)] });
    await settle();
    view.visibility.set(true);
    view.visibility.set(false);
    await settle();

    expect(view.feed.snapshot()).toBe(before);
    expect(view.replays).toHaveLength(2);
  });
});

describe("the event feed's loads", () => {
  it("a closed feed shows no refusal and sends no retry that would arrive after", async () => {
    const refused = openView(() => Promise.reject(new ApiError(500, "INTERNAL", "Internal error")));
    refused.stop();
    await settle();
    expect(refused.feed.snapshot()).toEqual({});

    const lost = openView(() => Promise.reject(new TypeError("Failed to fetch")));
    await settle();
    const sent = lost.replays.length;
    lost.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost.replays).toHaveLength(sent);
  });

  it("a replay that holds the same event twice shows it once", async () => {
    const view = openView([envelope(1, T0), envelope(1, T0), envelope(2, T0 + 1)]);
    await settle();

    expect(view.shown()).toEqual([`2@${T0 + 1}`, `1@${T0}`]);
  });

  it("an event already shown changes nothing", async () => {
    const view = openView([envelope(1, T0)]);
    await settle();
    const before = view.feed.snapshot();
    let changes = 0;
    view.feed.subscribe(() => {
      changes += 1;
    });

    view.daemon.openStream()?.send(frame(envelope(1, T0)));
    await settle();

    expect(view.feed.snapshot()).toBe(before);
    expect(changes).toBe(0);
  });

  it("a refusal stays shown while the stream adds events, and those events show", async () => {
    const refusal = new ApiError(500, "INTERNAL", "Internal error");
    const view = openView(() => Promise.reject(refusal));
    await settle();
    expect(view.feed.snapshot()).toEqual({ data: [], error: refusal });

    view.daemon.openStream()?.send(frame(envelope(1, T0)));
    await settle();

    expect(view.feed.snapshot().error).toBe(refusal);
    expect(view.shown()).toEqual([`1@${T0}`]);
  });

  it("a load that fails at the network level is sent again while the stream stays open", async () => {
    let failures = 2;
    const view = openView(() => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve({ events: [envelope(1, T0)] });
    });
    await settle();
    expect(view.replays).toEqual(["/v1/events?since=1h"]);
    expect(view.feed.snapshot()).toEqual({});

    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.replays).toHaveLength(2);
    expect(view.feed.snapshot()).toEqual({});
    await vi.advanceTimersByTimeAsync(2_000);

    expect(view.replays).toEqual(
      ["/v1/events?since=1h", "/v1/events?since=1h"].concat(["/v1/events?since=1h"]),
    );
    expect(view.connection.state().phase).toBe("connected");
    expect(view.shown()).toEqual([`1@${T0}`]);
  });

  it("a gap not loaded before the daemon goes away again is loaded with the next one", async () => {
    const view = openView([]);
    await settle();
    view.daemon.health = "up";

    view.daemon.openStream()?.end();
    await settle();
    const missed = envelope(1, Date.now() + 200);
    view.replayWith(() => Promise.reject(new TypeError("Failed to fetch")));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.replays.at(-1)).toBe("/v1/events?since=1s");

    view.daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.shown()).toEqual([]);

    view.replayWith(eventLog([missed]));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(view.connection.state().phase).toBe("connected");
    expect(view.shown()).toEqual([`1@${missed.timestamp}`]);
  });

  it("a stream that opens while a load is out is loaded again after it", async () => {
    let answer: (body: unknown) => void = () => {};
    const view = openView([]);
    await settle();
    expect(view.replays).toHaveLength(2);
    view.replayWith(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );

    view.visibility.set(true);
    await vi.advanceTimersByTimeAsync(2_000);
    view.visibility.set(false);
    await settle();
    expect(view.replays.at(-1)).toBe("/v1/events?since=2s");
    view.visibility.set(true);
    await vi.advanceTimersByTimeAsync(3_000);
    view.visibility.set(false);
    await settle();
    expect(view.replays).toHaveLength(3);

    view.replayWith([envelope(1, T0)]);
    answer({ events: [] });
    await settle();

    expect(view.replays.slice(3)).toEqual(["/v1/events?since=5s"]);
    expect(view.shown()).toEqual([`1@${T0}`]);
  });

  it("an event the stream brings while an older page loads shows once, at the top, and a second signal before the answer asks for nothing", async () => {
    const older = envelope(1, T0 - 10_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = openView((path) =>
      path.includes("before=")
        ? gate.then(() => ({ events: [older] }))
        : Promise.resolve({ events: [envelope(5, T0)] }),
    );
    await settle();

    view.feed.loadOlder();
    view.feed.loadOlder();
    view.daemon.openStream()?.send(frame(envelope(6, T0 + 1_000)));
    view.daemon.openStream()?.send(frame(envelope(6, T0 + 1_000)));
    await settle();
    release();
    await settle();

    expect(view.shown()).toEqual([`6@${T0 + 1_000}`, `5@${T0}`, `1@${T0 - 10_000}`]);
    expect(view.olderReads).toEqual([`/v1/events?before=evt_5_${T0}&limit=100`]);
  });

  it("asks for the newest page of older events at once when the last hour is empty, only on a feed that shows the history", async () => {
    const history = openView([], true);
    const recent = openView([]);
    await settle();

    expect(history.olderReads).toEqual(["/v1/events?limit=100"]);
    expect(recent.olderReads).toEqual([]);
  });

  it("a refused first read on a feed that shows the history asks for the newest page of older events", async () => {
    const view = openView(
      () => Promise.reject(new ApiError(500, "INTERNAL", "Internal error")),
      true,
    );
    await settle();

    expect(view.olderReads).toEqual(["/v1/events?limit=100"]);
  });
});
