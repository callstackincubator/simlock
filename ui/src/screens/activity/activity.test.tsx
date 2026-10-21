import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LoadView } from "../../ds";
import type { EventDetail, EventRow, EventsPage } from "../../state/events";
import { ActivityContent, EventDrawerBody } from ".";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function row(index: number, over: Partial<EventRow> = {}): EventRow {
  return {
    id: `evt_${index}`,
    iso: "2026-10-02T11:30:00.000Z",
    name: "lease.granted",
    summary: "claude-1 · mac-1",
    time: "11:30:00",
    to: `/activity/evt_${index}`,
    ...over,
  };
}

const DETAIL: EventDetail = {
  id: "evt_1",
  iso: "2026-10-02T11:30:00.000Z",
  line: "11:30:00 today · claude-1 · mac-1",
  name: "lease.granted",
  pairs: [
    { key: "leaseId", value: "lse_1" },
    { key: "nested", value: '{"deep":true}' },
  ],
};

function page(over: Partial<EventsPage> = {}): EventsPage {
  return {
    chart: {
      minutes: [
        { at: 1, count: 0, label: "11:29" },
        { at: 2, count: 3, label: "11:30" },
      ],
      summary: "3 events in the last hour; the busiest minute was 11:30, with 3.",
    },
    chosen: { detail: DETAIL, kind: "event" },
    chosenIndex: 0,
    end: undefined,
    held: 1,
    loadOlder: () => {},
    query: "",
    rows: [row(1)],
    subject: "all",
    urlId: "evt_1",
    ...over,
  };
}

function render(view: LoadView<EventsPage>): string {
  return renderToStaticMarkup(
    <ActivityContent
      view={view}
      onSubject={() => {}}
      onSearch={() => {}}
      onClose={() => {}}
      finalFocus={() => null}
    />,
  );
}

function drawer(over: Partial<EventsPage> = {}): string {
  return renderToStaticMarkup(<EventDrawerBody page={page(over)} />);
}

function ready(over: Partial<EventsPage> = {}): string {
  return render({ data: page(over), kind: "ready" });
}

describe("the events page", () => {
  it("lists each event as its time, its name and its summary, linking to its page", () => {
    const html = ready({ rows: [row(2), row(1, { name: "lease.expired", summary: "claude-2" })] });

    expect(html).toContain('<time class="event-time mono" dateTime="2026-10-02T11:30:00.000Z">');
    expect(text(html)).toContain(
      "11:30:00 lease.granted claude-1 · mac-1 11:30:00 lease.expired claude-2",
    );
    expect(html).toContain('href="/activity/evt_2"');
    expect(html).toContain('href="/activity/evt_1"');
  });

  it("marks the chosen event's row as the current one, and no other", () => {
    const html = ready({ rows: [row(2), row(1)] });

    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(
      /href="\/activity\/evt_1"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/activity\/evt_1"/,
    );
  });

  it("colours an event's name only where the row says it reports trouble", () => {
    const html = ready({
      rows: [row(3, { tone: "error" }), row(2, { tone: "warn" }), row(1)],
    });

    expect(html).toContain('<span class="mono event-error">lease.granted</span>');
    expect(html).toContain('<span class="mono event-warn">lease.granted</span>');
    expect(html).toContain('<span class="mono">lease.granted</span>');
  });

  it("draws only the rows in view of ten thousand, in a box a keyboard can scroll", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => row(index));

    const html = ready({ rows });

    expect(html).toContain('role="region" aria-label="Event feed" tabindex="0"');
    const drawn = html.match(/class="list-item"/g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(40);
  });

  it("shows the per-minute chart's numbers as text too", () => {
    const html = ready();

    expect(text(html)).toContain(
      "3 events in the last hour; the busiest minute was 11:30, with 3.",
    );
    expect(html).toContain('<div class="visually-hidden"><table class="chart-data">');
  });

  it("offers the subjects as a radio group with the chosen one checked", () => {
    const html = ready({ subject: "device" });

    const labels = [...html.matchAll(/<input type="radio"[^>]*\/><span>([^<]*)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["All", "Leases", "Devices", "Workers", "Components", "Other"]);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/value="device" checked=""|checked="" value="device"/);
  });

  it("says why an empty list is empty", () => {
    expect(text(ready({ chosen: { kind: "none" }, held: 0, rows: [] }))).toContain("Loading…");
    expect(
      text(
        ready({
          chosen: { kind: "none" },
          end: { retry: false, text: "No events yet." },
          held: 0,
          rows: [],
        }),
      ),
    ).toContain("No events yet.");
    expect(
      text(ready({ chosen: { kind: "none" }, held: 5, rows: [], subject: "device" })),
    ).toContain("No device events among those loaded.");
  });

  it("says it is loading, or why it could not load", () => {
    expect(text(render({ kind: "loading" }))).toContain("Loading…");
    expect(text(render({ kind: "refused", message: "Internal error" }))).toContain(
      "Internal error",
    );
  });

  it("shows a refusal above the events it keeps", () => {
    const html = render({ data: page(), kind: "ready", refusal: "Internal error" });

    expect(html).toContain('<p class="refusal" role="alert">Internal error</p>');
    expect(text(html)).toContain("lease.granted");
  });
});

describe("the events page's drawer", () => {
  it("says when and what the event was", () => {
    const html = drawer();

    expect(text(html)).toContain("11:30:00 today · claude-1 · mac-1");
  });

  it("shows the payload whole, keys as the daemon spelled them", () => {
    const html = drawer();

    expect(html).toContain('<dl class="facts facts-raw">');
    expect(text(html)).toContain('leaseId lse_1 nested {"deep":true}');
  });

  it("says when there is no payload", () => {
    expect(text(drawer({ chosen: { detail: { ...DETAIL, pairs: [] }, kind: "event" } }))).toContain(
      "No payload.",
    );
  });

  it("links to what the event is about when the console has a page for it", () => {
    const withAction = drawer({
      chosen: {
        detail: { ...DETAIL, action: { label: "Open lease", to: "/leases/lse_1/" } },
        kind: "event",
      },
    });

    expect(withAction).toContain(
      '<a class="button button-secondary" href="/leases/lse_1/">Open lease</a>',
    );
    expect(drawer()).not.toContain("Open lease");
  });

  it("says an event that is not among those loaded is not, and where older ones come from", () => {
    const html = drawer({ chosen: { id: "evt_old", kind: "missing" } });

    expect(text(html)).toContain(
      "This event is not among those loaded. Older events load as you scroll the list, or with Load older events.",
    );
  });
});
