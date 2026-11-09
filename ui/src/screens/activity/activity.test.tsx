import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LoadView } from "../../ds";
import type { ActivityRow, EventDetail, EventsPage } from "../../state/events";
import { ActivityContent, EventDrawerBody } from ".";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function row(index: number, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    detail: "mac-1",
    id: `evt_${index}`,
    iso: "2026-10-02T11:30:00.000Z",
    kind: "lease",
    name: "lease.granted",
    subject: "claude-1",
    summary: "claude-1 · mac-1",
    time: "11:30:00",
    to: `/activity/evt_${index}`,
    worker: "mac-studio-01",
    workerTitle: "wrk_1",
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
      short: "3 in the last hour · peak 3 at 11:30",
      summary: "3 events in the last hour; the busiest minute was 11:30, with 3.",
    },
    chosen: { detail: DETAIL, kind: "event" },
    chosenIndex: 0,
    coverage: undefined,
    end: undefined,
    facets: {
      kinds: [
        { checked: true, count: 3, label: "Leases", value: "lease" },
        { checked: false, count: 0, label: "Queue", value: "queue" },
      ],
      problems: { checked: false, count: 1, label: "Problems only", value: "problems" },
      workers: [
        { checked: false, count: 2, label: "mac-studio-01", value: "wrk_1" },
        { checked: false, count: 1, label: "Other", value: "" },
      ],
    },
    filter: { kinds: ["lease"], problems: false, workers: [] },
    held: 1,
    loadOlder: () => {},
    query: "",
    range: "1h",
    rows: [row(1)],
    urlId: "evt_1",
    ...over,
  };
}

function render(view: LoadView<EventsPage>): string {
  return renderToStaticMarkup(
    <ActivityContent
      view={view}
      range="1h"
      onRange={() => {}}
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
  it("lists each event as its icon, name, subject, worker and time, linking to its page", () => {
    const html = ready({
      rows: [row(2), row(1, { detail: "", name: "lease.expired", subject: "claude-2" })],
    });

    expect(html).toContain('<time class="event-time mono" dateTime="2026-10-02T11:30:00.000Z">');
    expect(text(html)).toContain(
      "lease.granted claude-1 · mac-1 mac-studio-01 11:30:00 lease.expired claude-2 mac-studio-01 11:30:00",
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

  it("tints an event's icon by what the row says: good, warning or trouble, and none when quiet", () => {
    const html = ready({
      rows: [row(4, { mark: "error" }), row(3, { mark: "warn" }), row(2, { mark: "ok" }), row(1)],
    });

    expect(html).toContain('class="event-icon event-icon-error"');
    expect(html).toContain('class="event-icon event-icon-warn"');
    expect(html).toContain('class="event-icon event-icon-ok"');
    expect(html.match(/class="event-icon"/g)).toHaveLength(1);
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

  it("offers Kind, State and Worker as checkboxes with their counts, the ticked ones checked", () => {
    const html = ready();

    expect(text(html)).toContain("Kind Leases 3 Queue 0 State Problems only 1 Worker");
    expect(text(html)).toContain("mac-studio-01 2 Other 1");
    expect(html.match(/<input type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
  });

  it("puts the search and the range in the header, the range as a radio group", () => {
    const html = ready();

    expect(html).toContain('placeholder="Filter events"');
    expect(html).not.toContain("newest first");
    const labels = [...html.matchAll(/<input type="radio"[^>]*\/><span>([^<]*)<\/span>/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["1 h", "6 h", "24 h", "7 d"]);
    expect(html).toMatch(/value="1h" checked=""|checked="" value="1h"/);
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
    expect(text(ready({ chosen: { kind: "none" }, held: 5, rows: [] }))).toContain(
      "No events match these filters among those loaded.",
    );
  });

  it("says when history has not reached the range, with a way to load more", () => {
    const html = ready({ coverage: "The events loaded do not reach back 6 hours yet." });

    expect(text(html)).toContain("The events loaded do not reach back 6 hours yet.");
    expect(text(html)).toContain("Load older events");
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
