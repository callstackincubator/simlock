import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiPath, type ApiResponse } from "../api";
import type { Clock } from "../live/connection";
import { Loaded } from "../live/route-state";
import { connect, settle } from "../live/test-support";
import { EventFeed } from "./event-feed";
import { EventList } from "./events";
import { type ConsoleEvent, MAX_EVENTS } from "./events-model";
import type { WorkerView } from "./workers-model";

const T0 = Date.parse("2026-10-02T11:30:00Z");

/** Vitest's fake time and timers, as the live connection's tests use them. */
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

/** One event as the stream frames it. */
function frame(event: ReturnType<typeof envelope>): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The text a screen shows, without markup. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** What `GET /v1/events` answers: these events, or whatever this returns. */
type Replay = unknown[] | ((path: ApiPath) => Promise<unknown>);

/**
 * A daemon's event file: answers `GET /v1/events?since=<n>s|1h` with the events newer than that,
 * by the fake clock, as the daemon does.
 */
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

/**
 * The events view's feed on a live connection to a scripted daemon. `replay` is what
 * `GET /v1/events` answers, whatever its `since`; every other read answers `{}`.
 */
function openView(first: Replay = []) {
  const live = connect();
  const replays: ApiPath[] = [];
  let replay: Replay = first;
  live.daemon.reads = async (path) => {
    if (!path.startsWith("/v1/events?")) return { body: {}, date: null };
    replays.push(path);
    const body = typeof replay === "function" ? await replay(path) : { events: replay };
    return { body, date: null } satisfies ApiResponse<unknown>;
  };
  const feed = new EventFeed(async (path) => (await live.daemon.get(path)).body, fakeClock);
  live.connection.onEvent(feed.streamEvent);
  live.connection.onStreamOpened(feed.streamOpened);
  const stop = feed.start();
  return {
    ...live,
    feed,
    replays,
    stop,
    /** Sets what `GET /v1/events` answers from now on. */
    replayWith(next: Replay) {
      replay = next;
    },
    /** The ids of the events the view shows, newest first. */
    ids(): string[] {
      return (feed.snapshot().data ?? []).map((event) => event.id);
    },
    /** The events the view shows, as `seq@timestamp`, newest first. */
    shown(): string[] {
      return (feed.snapshot().data ?? []).map((event) => `${event.seq}@${event.timestamp}`);
    },
  };
}

/** What the view's page shows for the feed now, as `EventsView` renders it, as markup. */
function screen(feed: EventFeed): string {
  return renderToStaticMarkup(
    <Loaded state={feed.snapshot()}>
      {(events) => <EventList events={events} workers={undefined} />}
    </Loaded>,
  );
}

/** A worker the daemon lists, with a label or without one. */
function worker(id: string, label?: string): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: T0,
    leases: [],
    ...(label === undefined ? {} : { label }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the events view", () => {
  it("the events view lists events from the stream and from the replay once each", async () => {
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
    // The stream sends it before the replay answers, and the replay holds it too.
    view.daemon.openStream()?.send(frame(both));
    view.replayWith([envelope(6, T0 - 1_000), both]);
    await settle();
    expect(view.shown()).toEqual([`7@${T0}`, `6@${T0 - 1_000}`]);

    // And the other way round: replayed first, then streamed.
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

    // The daemon stops, and starts again with its seq counting from 1.
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

    // The daemon goes away. `/v1/healthz` answers after 1 s; the new stream's headers take 0.3 s
    // more, so the stream was closed for 1.3 s.
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

  it("a view opened before the stream loads the recent events again once the stream opens", async () => {
    const view = openView();
    // The first load answers before the stream's headers arrive.
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

    // The stream's headers took longer than the load: its first open comes after.
    view.feed.streamOpened({});
    await settle();

    expect(view.replays.slice(sent)).toEqual(["/v1/events?since=1h"]);
    expect(view.shown()).toEqual([`1@${T0}`]);
  });

  it("the view keeps the newest 10,000 events", async () => {
    expect(MAX_EVENTS).toBe(10_000);
    const view = openView();
    view.replayWith(
      Array.from({ length: MAX_EVENTS }, (_, index) => envelope(index + 1, T0 + index * 1_000)),
    );
    await settle();
    expect(view.shown()).toHaveLength(MAX_EVENTS);

    view.daemon.openStream()?.send(frame(envelope(MAX_EVENTS + 1, T0 + MAX_EVENTS * 1_000)));
    // An event older than every one kept arrives late: it does not push a newer one out.
    view.daemon.openStream()?.send(frame(envelope(0, T0 - 1_000)));
    await settle();

    const shown = view.shown();
    expect(shown).toHaveLength(MAX_EVENTS);
    expect(shown[0]).toBe(`${MAX_EVENTS + 1}@${T0 + MAX_EVENTS * 1_000}`);
    // The oldest one dropped off the end.
    expect(shown.at(-1)).toBe(`2@${T0 + 1_000}`);
  });

  it("an unknown event name renders with its payload", () => {
    const events: ConsoleEvent[] = [
      {
        event: "gizmo.frobnicated",
        payload: { count: 3, nested: { deep: true }, reason: "because", workerId: "wrk_1" },
        seq: 3,
        timestamp: T0,
      },
      // A payload that is not an object at all.
      { event: "gizmo.listed", payload: ["a", 1], seq: 2, timestamp: T0 - 1_000 },
      // No payload at all.
      { event: "gizmo.pinged", payload: undefined, seq: 1, timestamp: T0 - 2_000 },
    ];

    const html = renderToStaticMarkup(
      <EventList events={events} workers={[worker("wrk_1", "mac-1")]} />,
    );
    const shown = text(html);

    expect(shown).toContain(
      'gizmo.frobnicated mac-1 count 3 nested {"deep":true} reason because workerId wrk_1',
    );
    expect(shown).toContain('gizmo.listed payload ["a",1]');
    expect(shown).toMatch(/gizmo\.pinged$/);
    expect(html.match(/<dl/g)).toHaveLength(2);
  });

  it("the time is the event's time of day on the browser's clock face", () => {
    const zone = process.env.TZ;
    // Five and a half hours ahead of UTC, so neither the hour nor the minute matches UTC's.
    process.env.TZ = "Asia/Kolkata";
    try {
      const event: ConsoleEvent = { event: "lease.granted", payload: {}, seq: 1, timestamp: T0 };

      const html = renderToStaticMarkup(<EventList events={[event]} workers={undefined} />);

      expect(html).toContain(
        '<time class="mono" dateTime="2026-10-02T11:30:00.000Z">17:00:00</time>',
      );
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("an empty list says why it is empty", () => {
    const leases: ConsoleEvent[] = [{ event: "lease.granted", payload: {}, seq: 1, timestamp: T0 }];
    const render = (events: ConsoleEvent[], filter: "all" | "device") =>
      text(renderToStaticMarkup(<EventList events={events} workers={undefined} filter={filter} />));

    expect(render([], "all")).toBe("No events in the last hour.");
    expect(render([], "device")).toBe("No events in the last hour.");
    expect(render(leases, "device")).toBe("No events of this kind.");
  });

  it("the filter shows only the events about the subject it names", () => {
    const events: ConsoleEvent[] = [
      "lease.granted",
      "device.ready",
      "worker.connected",
      "component.installed",
      "daemon.started",
      "gizmo.frobnicated",
    ].map((event, index) => ({ event, payload: {}, seq: index, timestamp: T0 - index }));
    const names = (filter: "all" | "lease" | "device" | "worker" | "component" | "other") =>
      [
        ...renderToStaticMarkup(
          <EventList events={events} workers={undefined} filter={filter} />,
        ).matchAll(/<span class="event-name mono">([^<]*)<\/span>/g),
      ].map((match) => match[1]);

    expect(names("all")).toHaveLength(6);
    expect(names("lease")).toEqual(["lease.granted"]);
    expect(names("device")).toEqual(["device.ready"]);
    expect(names("worker")).toEqual(["worker.connected"]);
    expect(names("component")).toEqual(["component.installed"]);
    expect(names("other")).toEqual(["daemon.started", "gizmo.frobnicated"]);
  });

  it("a worker the console does not know, or that has no label, shows as its id", () => {
    const about = (workerId: string, seq: number): ConsoleEvent => ({
      event: "lease.granted",
      payload: { workerId },
      seq,
      timestamp: T0 - seq,
    });
    const events = [about("wrk_1", 1), about("wrk_2", 2), about("wrk_gone", 3)];
    const workers = [worker("wrk_1", "mac-1"), worker("wrk_2")];
    const names = (listed: readonly WorkerView[] | undefined) =>
      [
        ...renderToStaticMarkup(<EventList events={events} workers={listed} />).matchAll(
          /<span class="event-worker">([^<]*)<\/span>/g,
        ),
      ].map((match) => match[1]);

    // Newest first: wrk_1, then wrk_2, then wrk_gone.
    expect(names(workers)).toEqual(["mac-1", "wrk_2", "wrk_gone"]);
    // Before the worker list is read, every worker shows as its id.
    expect(names(undefined)).toEqual(["wrk_1", "wrk_2", "wrk_gone"]);
  });
  it("a worker.rejected event names no worker, even one the console knows", () => {
    const rejected: ConsoleEvent = {
      event: "worker.rejected",
      payload: { reason: "unauthenticated", workerId: "wrk_1" },
      seq: 1,
      timestamp: T0,
    };

    const html = renderToStaticMarkup(
      <EventList events={[rejected]} workers={[worker("wrk_1", "mac-1")]} />,
    );

    expect(html).not.toContain("event-worker");
    expect(text(html)).not.toContain("mac-1");
    // The claim is still shown, as the payload the daemon sent.
    expect(text(html)).toContain("workerId wrk_1");
  });

  it("an envelope without a numeric seq, a timestamp that is a date, or a name is not shown", async () => {
    const view = openView();
    view.replayWith([
      { event: "lease.granted", timestamp: T0 },
      { event: "lease.granted", seq: 1 },
      { seq: 2, timestamp: T0 },
      { event: "lease.granted", seq: 3, timestamp: 1e300 },
      // A date, but as a string: not a timestamp.
      { event: "lease.granted", seq: 5, timestamp: "2026-10-02T11:30:00Z" },
      { event: "lease.granted", seq: "6", timestamp: T0 },
      envelope(4, T0),
    ]);
    await settle();

    expect(view.shown()).toEqual([`4@${T0}`]);
  });

  it("until the first load answers, the view says it is loading", async () => {
    let answer: (body: unknown) => void = () => {};
    const view = openView(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // The stream opens and sends an event; both loads of the last hour are still out.
    await settle();
    view.daemon.openStream()?.send(frame(envelope(2, T0)));
    await settle();
    expect(text(screen(view.feed))).toBe("Loading…");

    answer({ events: [envelope(1, T0 - 1_000)] });
    await settle();

    expect(view.shown()).toEqual([`2@${T0}`, `1@${T0 - 1_000}`]);
  });

  it("a load the daemon refuses shows why, and keeps the events already shown", async () => {
    const view = openView();
    view.replayWith([envelope(1, T0)]);
    await settle();
    expect(view.feed.snapshot().error).toBeUndefined();

    // The stream is closed and opens again; the daemon refuses the load that fills the gap.
    const refusal = new ApiError(500, "INTERNAL", "Internal error");
    view.replayWith(() => Promise.reject(refusal));
    view.visibility.set(true);
    view.visibility.set(false);
    await settle();

    expect(view.feed.snapshot().error).toBe(refusal);
    expect(view.shown()).toEqual([`1@${T0}`]);
    const shown = screen(view.feed);
    expect(shown).toContain('<p class="refusal" role="alert">Internal error</p><div class="feed">');
    expect(text(shown)).toMatch(/^Internal error \d\d:\d\d:\d\d lease\.granted$/);

    // The next load that answers clears it.
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

  it("a view opened while the daemon is away loads the last hour once it is back", async () => {
    // The daemon is gone: the view's first loads fail at the network level.
    const view = openView(() => Promise.reject(new TypeError("Failed to fetch")));
    view.daemon.health = "unreachable";
    await settle();
    view.daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(view.connection.state().phase).toBe("disconnected");
    // Nothing of its own: the connection says the daemon is lost.
    expect(view.feed.snapshot()).toEqual({});

    // Back, with an event from half an hour ago in its log: only the last hour holds it.
    const earlier = envelope(1, Date.now() - 30 * 60_000);
    view.replayWith(eventLog([earlier]));
    view.daemon.health = "up";
    await vi.advanceTimersByTimeAsync(8_000);
    expect(view.connection.state().phase).toBe("connected");

    expect(view.shown()).toEqual([`1@${earlier.timestamp}`]);
  });

  it("a closed view ignores what arrives after", async () => {
    let answer: (body: unknown) => void = () => {};
    let loads = 0;
    // The first load answers at once; the one the stream's opening asks for is held.
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
    // The stream opening again asked for nothing.
    expect(view.replays).toHaveLength(2);
  });
});

describe("the events view's loads", () => {
  it("a closed view shows no refusal and sends no retry that would arrive after", async () => {
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

    // After 1 second, and after 2 more.
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

    // The first outage: the stream ends, with an event sent just after, and the daemon is back
    // after 1 s; the load of that gap does not reach it.
    view.daemon.openStream()?.end();
    await settle();
    const missed = envelope(1, Date.now() + 200);
    view.replayWith(() => Promise.reject(new TypeError("Failed to fetch")));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.replays.at(-1)).toBe("/v1/events?since=1s");

    // The second outage, before that load is sent again, then 30 s more of failed loads.
    view.daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.shown()).toEqual([]);

    // The daemon answers again. The load reaches back to the first gap, not just the second.
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

    // A gap load goes out; the stream closes and opens again before it answers.
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

    // Again, from the first gap's start: the answer may be older than what the second missed.
    expect(view.replays.slice(3)).toEqual(["/v1/events?since=5s"]);
    expect(view.shown()).toEqual([`1@${T0}`]);
  });
});
