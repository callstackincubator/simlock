import { inConsole } from "../../state/test-support";
import { describe, expect, it } from "vitest";

import { figuresOf } from "../../model/figures";
import { overviewOf } from "../../model/overview";
import { statsOf } from "../../model/test-support";
import type { WorkerView } from "../../model/workers";
import type { Overview } from "../../state/overview";
import { OverviewBody } from "./index";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOW = new Date(2026, 9, 15, 12, 0).getTime();

const quiet: Overview = {
  capacity: [],
  ending: { meta: "0 under 5 min", rows: [] },
  figures: { kind: "loading" },
  queue: { meta: "0 waiting", rows: [] },
  tiles: [],
  fleet: { attention: [], healthy: [], total: 0 },
};

function host(id: string, over: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: {
      android: { limit: 2, running: 0 },
      global: { limit: 6, running: 0, warm: 0 },
      ios: { limit: 4, running: 0 },
    },
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    label: id,
    lastSeenAt: NOW,
    leases: [],
    ...over,
  } as unknown as WorkerView;
}

function withFigures(shape: { coversFrom?: number; partial?: boolean }): Overview {
  const stats = statsOf({
    bucketMs: 5 * 60_000,
    from: NOW - 6 * 60 * 60_000,
    granted: 3,
    to: NOW,
    waitP95: 38_000,
    ...shape,
  });
  return overviewOf({
    figures: { data: figuresOf(stats, "6h", NOW), kind: "ready" },
    now: NOW,
    range: "6h",
    requests: [],
    workers: [],
  });
}

function fleetOfWorkers(workers: readonly WorkerView[]): Overview["fleet"] {
  return overviewOf({ now: NOW, requests: [], workers }).fleet;
}

describe("the overview screen", () => {
  it("says so where a fleet has no workers, no queue and nothing needs you, and draws no banner or table", () => {
    const html = inConsole(<OverviewBody overview={quiet} />);

    expect(text(html)).toContain("No workers have connected.");
    expect(text(html)).toContain("Nothing is waiting.");
    expect(text(html)).not.toContain("need you");
    expect(html).not.toContain("<table");
  });

  it("draws the banner with its count, the first issue as a link, how many more and the Inbox button", () => {
    const html = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          banner: {
            count: 3,
            first: { text: "mac-1 · disconnected", to: "/inbox/w1%2Fdisconnected" },
            more: 2,
            title: "3 things need you",
          },
        }}
      />,
    );

    expect(text(html)).toContain("3 3 things need you mac-1 · disconnected · and 2 more");
    expect(html).toContain('href="/inbox/w1%2Fdisconnected"');
    expect(html).toMatch(/href="\/inbox"[^>]*>Open Inbox</);
  });

  it("links every KPI tile to its page", () => {
    const html = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          tiles: [
            { label: "Leased", to: "/leases", value: "1" },
            { label: "Wait p95", to: "/usage?range=6h", value: "4 s" },
          ],
        }}
      />,
    );

    expect(html).toContain('href="/leases"');
    expect(html).toContain('href="/usage?range=6h"');
  });

  it("draws the Fleet card as the Fleet page's table: groups, a row link each, the state pill, and the Open fleet button", () => {
    const html = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          fleet: fleetOfWorkers([host("mac-1"), host("mac-2", { drained: true })]),
        }}
      />,
    );
    const shown = text(html);

    expect(html).toContain('href="/fleet/mac-1"');
    expect(html).toContain('href="/fleet/mac-2"');
    expect(shown).toContain("Needs attention 1");
    expect(shown).toContain("Healthy 1");
    expect(shown).toContain("Worker State Slots CPU Mem Disk Leases");
    expect(shown).toContain("drained");
    expect(shown).toContain("2 workers");
    expect(html).toContain('<tr class="table-row-link row-warn"');
    expect(html).not.toContain("overview-wall");
    expect(shown).toContain("1–2 of 2");
    expect(html).toContain('href="/fleet">Open fleet</a>');
  });

  it("says how many of the workers the card shows when it cuts the list", () => {
    const workers = Array.from({ length: 10 }, (_, index) => host(`w-${index}`));
    const html = inConsole(
      <OverviewBody overview={{ ...quiet, fleet: fleetOfWorkers(workers) }} />,
    );

    expect(text(html)).toContain("10 workers");
    expect(text(html)).toContain("8 of 10");
    expect(html.match(/href="\/fleet\/w-\d"/g)).toHaveLength(16);
  });

  it("lists the queue and the ending leases as links, and says a refused queue is unavailable, not empty", () => {
    const listed = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          ending: {
            meta: "1 under 5 min",
            rows: [
              {
                holder: "ci-nightly",
                holderTitle: "ci-nightly",
                key: "l1",
                kind: "unknown",
                percent: 20,
                remaining: "2:36",
                sub: "iPhone 16 · mac-1",
                to: "/leases/l1",
              },
            ],
          },
          queue: {
            meta: "1 waiting · longest 41 s",
            rows: [
              {
                holder: "codex:pr-1",
                holderTitle: "codex:pr-1",
                key: "q1",
                kind: "codex",
                place: "#1",
                to: "/queue/q1",
                waited: "41 s",
              },
            ],
          },
        }}
      />,
    );
    const refused = text(
      inConsole(<OverviewBody overview={{ ...quiet, queue: { unavailable: "Forbidden" } }} />),
    );

    expect(listed).toContain('href="/queue/q1"');
    expect(listed).toContain('href="/leases/l1"');
    expect(text(listed)).toContain("2:36");
    expect(refused).toContain("Unavailable: Forbidden");
    expect(refused).not.toContain("Nothing is waiting.");
  });

  it("draws the capacity rings with their leased counts, and notes workers not read yet", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={{
            ...quiet,
            capacity: [
              { leased: 13, name: "iOS", notRead: 2, parts: [], total: 28 },
              { leased: 0, name: "Android", notRead: 0, parts: [], total: 0 },
            ],
          }}
        />,
      ),
    );

    expect(shown).toContain("46%");
    expect(shown).toContain("13 of 28 leased · 2 not read yet");
    expect(shown).toContain("0 of 0 leased");
  });

  it("draws the chart with now and peak beside its title, the queue bars, and a table of each series for a screen reader", () => {
    const html = inConsole(<OverviewBody overview={withFigures({})} range="6h" />);
    const shown = text(html);

    expect(shown).toContain("Leases held");
    expect(html).toContain("Requests waiting · 6 h");
    expect(html.match(/<table class="chart-data"/g)).toHaveLength(2);
    expect(html).toContain('class="bars"');
    expect(html).not.toContain("Device slots in use");
  });

  it("shows the partial note when the figures carry one, and none otherwise", () => {
    const partial = text(
      inConsole(
        <OverviewBody overview={withFigures({ coversFrom: NOW - 90 * 60_000, partial: true })} />,
      ),
    );
    const whole = text(inConsole(<OverviewBody overview={withFigures({})} />));

    expect(partial).toContain("Figures cover from today 10:30.");
    expect(whole).not.toContain("Figures cover from");
  });

  it("keeps the other cards when the stats are refused, and says so once at the top and marks each figure card unavailable", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={overviewOf({
            figures: { kind: "refused", message: "The stats are not allowed." },
            now: NOW,
            requests: [],
            workers: [],
          })}
        />,
      ),
    );

    expect(shown).toContain("Capacity");
    expect(shown).toContain("No workers have connected.");
    expect(shown.split("The stats are not allowed.")).toHaveLength(2);
    expect(shown.split("Not available.")).toHaveLength(3);
  });

  it("keeps the last figures with the refusal above them when a stats read is refused after an answer", () => {
    const kept = withFigures({});
    const stale = {
      ...kept,
      figures: { ...kept.figures, refusal: "The stats are not allowed." },
    } as Overview;
    const shown = text(inConsole(<OverviewBody overview={stale} range="6h" />));

    expect(shown.split("The stats are not allowed.")).toHaveLength(2);
    expect(shown).toContain("Leases held");
  });
});
