import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { figuresOf } from "../../model/figures";
import { overviewOf } from "../../model/overview";
import { statsOf } from "../../model/test-support";
import type { Overview } from "../../state/overview";
import { OverviewBody } from "./index";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const quiet: Overview = {
  activity: [],
  attention: [],
  figures: { kind: "loading" },
  platforms: [],
  tiles: [],
  workers: [],
};

describe("the overview screen", () => {
  it("says so in one line where a fleet has no workers, nothing needs attention and nothing happened", () => {
    const shown = text(renderToStaticMarkup(<OverviewBody overview={quiet} />));

    expect(shown).toContain("No workers have connected.");
    expect(shown).toContain("Nothing needs attention.");
    expect(shown).toContain("No events in the last hour.");
  });

  it("names each worker's health in its square, its devices in words beside the slots, and a muted dash where a count is not known", () => {
    const html = renderToStaticMarkup(
      <OverviewBody
        overview={{
          ...quiet,
          platforms: [
            { busyPercent: 0, leasedPercent: 0, name: "iOS", readyPercent: 0 },
            {
              busyPercent: 0,
              leasedPercent: 50,
              limit: 4,
              name: "Android",
              readyPercent: 0,
              running: 2,
            },
          ],
          workers: [
            {
              health: { tone: "warn", word: "memory 88%" },
              id: "w1",
              leases: 2,
              name: "mac-mini-01",
              slots: [
                { kind: "leased", label: "iPhone 16 18.4, leased" },
                { kind: "free", label: "free" },
              ],
              slotsLabel: "1 leased, 1 free",
              to: "/fleet/w1",
            },
            {
              health: { tone: "warn", word: "starting" },
              id: "w2",
              name: "mac-mini-02",
              slots: [],
              slotsLabel: "Not reported",
              to: "/fleet/w2",
            },
          ],
        }}
      />,
    );

    expect(html).toContain('class="status-dot status-dot-warn" role="img" aria-label="memory 88%"');
    expect(html).toContain('role="img" aria-label="1 leased, 1 free"');
    expect(html).toContain('href="/fleet/w1"');
    expect(text(html)).not.toContain("memory 88%");
    expect(html).toContain('<td data-label="Leases" class="num"><span class="muted">—</span></td>');
    expect(html).toContain('<span class="muted">—</span></span></p>');
    expect(text(html)).toContain("2 of 4 running");
    expect(html.match(/class="share-bar"/g)).toHaveLength(1);
  });

  it("draws the range picker as a radio group of four with the chosen range checked, three chart panels and the Capacity panel", () => {
    const shown = renderToStaticMarkup(
      <OverviewBody overview={withFigures({})} range="6h" onRange={() => undefined} />,
    );

    const radios = [...shown.matchAll(/<input type="radio"[^>]*>/g)].map(([tag]) => tag);
    expect(radios.map((tag) => /value="([^"]*)"/.exec(tag)?.[1])).toEqual([
      "1h",
      "6h",
      "24h",
      "7d",
    ]);
    expect(radios.filter((tag) => tag.includes("checked"))).toHaveLength(1);
    expect(radios.find((tag) => tag.includes("checked"))).toContain('value="6h"');
    expect(text(shown)).toContain("1 hour 6 hours 24 hours 7 days");
    const headings = [...shown.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(([, name]) => name);
    expect(headings).toEqual(
      expect.arrayContaining([
        "Leases held, last 6 hours",
        "Requests in the queue, last 6 hours",
        "Device slots in use, last 6 hours",
        "Capacity",
      ]),
    );
  });

  it("shows the partial note above the tiles when the figures carry one, and no note otherwise", () => {
    const partial = text(
      renderToStaticMarkup(
        <OverviewBody
          overview={withFigures({ coversFrom: NOW - 90 * 60_000, partial: true })}
          range="1h"
          onRange={() => undefined}
        />,
      ),
    );
    const whole = text(
      renderToStaticMarkup(
        <OverviewBody overview={withFigures({})} range="1h" onRange={() => undefined} />,
      ),
    );

    expect(partial).toContain("Figures cover from today 10:30.");
    expect(partial.indexOf("Figures cover from")).toBeLessThan(partial.indexOf("Utilisation"));
    expect(whole).not.toContain("Figures cover from");
  });

  it("shows a refused stats read as one item after Workers and as one panel, and leaves the fleet's tiles and panels", () => {
    const shown = text(
      renderToStaticMarkup(
        <OverviewBody
          overview={overviewOf({
            events: [],
            figures: { kind: "refused", message: "The stats are not allowed." },
            now: NOW,
            requests: [],
            workers: [],
          })}
          range="1h"
          onRange={() => undefined}
        />,
      ),
    );

    expect(shown.split("The stats are not allowed.")).toHaveLength(3);
    expect(shown.indexOf("The stats are not allowed.")).toBeGreaterThan(shown.indexOf("Workers 0"));
    for (const kept of ["Utilisation", "Leases", "Waiting", "Capacity", "Attention", "Activity"]) {
      expect(shown, kept).toContain(kept);
    }
    expect(shown).toContain("No workers have connected.");
    for (const gone of ["Granted", "Wait p95", "Leases held, last hour"]) {
      expect(shown, gone).not.toContain(gone);
    }
  });

  it("keeps the last figures with the refusal above them when a stats read is refused after an answer", () => {
    const kept = withFigures({});
    const stale = {
      ...kept,
      figures: { ...kept.figures, refusal: "The stats are not allowed." },
    } as Overview;
    const shown = text(
      renderToStaticMarkup(<OverviewBody overview={stale} range="6h" onRange={() => undefined} />),
    );

    expect(shown.split("The stats are not allowed.")).toHaveLength(2);
    expect(shown.indexOf("The stats are not allowed.")).toBeLessThan(shown.indexOf("Granted"));
    expect(shown).toContain("Wait p95");
    expect(shown).toContain("Leases held, last 6 hours");
  });

  it("shows Loading… in the same two places while the stats read is loading", () => {
    const shown = text(
      renderToStaticMarkup(
        <OverviewBody
          overview={overviewOf({ events: [], now: NOW, requests: [], workers: [] })}
          range="1h"
          onRange={() => undefined}
        />,
      ),
    );

    expect(shown.split("Loading…")).toHaveLength(3);
    expect(shown).toContain("Utilisation");
    expect(shown).not.toContain("Wait p95");
  });
});

const NOW = new Date(2026, 9, 15, 12, 0).getTime();

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
    events: [],
    figures: { data: figuresOf(stats, "6h", NOW), kind: "ready" },
    now: NOW,
    requests: [],
    workers: [],
  });
}
