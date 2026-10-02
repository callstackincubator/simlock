import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiPath, ApiResponse } from "../api";
import { connect, settle } from "../live/test-support";
import { EventFeed } from "./event-feed";
import { EventList } from "./events";
import { type ConsoleEvent, MAX_EVENTS } from "./events-model";

const T0 = Date.parse("2026-10-02T11:30:00Z");

function envelope(seq: number, timestamp: number, event = "lease.granted", payload: unknown = {}) {
  return { event, module: "lease", payload, seq, timestamp };
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

/**
 * The events view's feed on a live connection to a scripted daemon. `replay` is what
 * `GET /v1/events` answers, whatever its `since`; every other read answers `{}`.
 */
function openView() {
  const live = connect();
  const replays: ApiPath[] = [];
  let replay: unknown[] = [];
  live.daemon.reads = (path) => {
    if (path.startsWith("/v1/events?")) replays.push(path);
    const body = path.startsWith("/v1/events?") ? { events: replay } : {};
    return Promise.resolve({ body, date: null } satisfies ApiResponse<unknown>);
  };
  const feed = new EventFeed(async (path) => (await live.daemon.get(path)).body);
  live.connection.onEvent(feed.streamEvent);
  live.connection.onStreamOpened(feed.streamOpened);
  feed.start();
  return {
    ...live,
    feed,
    replays,
    /** Sets what `GET /v1/events` answers from now on. */
    replayWith(events: unknown[]) {
      replay = events;
    },
    /** The events the view shows, as `seq@timestamp`, newest first. */
    shown(): string[] {
      return (feed.snapshot().data ?? []).map((event) => `${event.seq}@${event.timestamp}`);
    },
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
    view.visibility.set(false);
    await settle();

    expect(view.replays.slice(2)).toEqual(["/v1/events?since=5s"]);
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

  it("the view keeps the newest 1000 events", async () => {
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
        seq: 2,
        timestamp: T0,
      },
      // A payload that is not an object at all.
      { event: "gizmo.listed", payload: ["a", 1], seq: 1, timestamp: T0 - 1_000 },
    ];

    const shown = text(
      renderToStaticMarkup(
        <EventList events={events} workerName={(id) => (id === "wrk_1" ? "mac-1" : id)} />,
      ),
    );

    expect(shown).toContain(
      'gizmo.frobnicated mac-1 count 3 nested {"deep":true} reason because workerId wrk_1',
    );
    expect(shown).toContain('gizmo.listed payload ["a",1]');
  });

  it("a worker the console does not know shows as its id", () => {
    const event: ConsoleEvent = {
      event: "lease.granted",
      payload: { workerId: "wrk_gone" },
      seq: 1,
      timestamp: T0,
    };

    const html = renderToStaticMarkup(<EventList events={[event]} workerName={(id) => id} />);

    expect(html).toContain('<span class="event-worker">wrk_gone</span>');
  });

  it("an envelope without a seq, a timestamp that is a date, or a name is not shown", async () => {
    const view = openView();
    view.replayWith([
      { event: "lease.granted", timestamp: T0 },
      { event: "lease.granted", seq: 1 },
      { seq: 2, timestamp: T0 },
      { event: "lease.granted", seq: 3, timestamp: 1e300 },
      envelope(4, T0),
    ]);
    await settle();

    expect(view.shown()).toEqual([`4@${T0}`]);
  });
});
