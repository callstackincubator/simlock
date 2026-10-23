import { inConsole } from "../../state/test-support";
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
  figures: { kind: "loading" },
  capacity: [],
  ending: { label: "Ending soon", value: "0" },
  inbox: { couldNotCheck: [], needsYou: [], problems: 0 },
  tiles: [],
  workers: [],
};

describe("the overview screen", () => {
  it("says so in one line where a fleet has no workers and nothing needs you", () => {
    const shown = text(inConsole(<OverviewBody overview={quiet} />));

    expect(shown).toContain("No workers have connected.");
    expect(shown).toContain("Nothing needs you");
    expect(shown).not.toContain("Activity");
  });

  it("shows the Needs you panel with its rows and the Inbox link, and no Nothing needs you", () => {
    const shown = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          inbox: {
            couldNotCheck: [],
            needsYou: [
              {
                key: "w1/disconnected",
                subject: "mac-1",
                to: "/inbox/w1%2Fdisconnected",
                tone: "error",
                word: "disconnected",
              },
            ],
            problems: 5,
          },
        }}
      />,
    );

    expect(shown).toContain('href="/inbox/w1%2Fdisconnected"');
    expect(shown).toContain('href="/inbox">All in Inbox (5)</a>');
    expect(text(shown)).toContain("Needs you");
    expect(text(shown)).not.toContain("Nothing needs you");
  });

  it("says Could not check, and not Nothing needs you, when a read failed and no problem is known", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={{
            ...quiet,
            inbox: { couldNotCheck: ["waiting requests", "leases"], needsYou: [], problems: 0 },
          }}
        />,
      ),
    );

    expect(shown).toContain("Could not check: waiting requests, leases");
    expect(shown).not.toContain("Nothing needs you");
  });

  it("shows the Needs you panel and the Could not check line together when a read failed and a problem is known", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={{
            ...quiet,
            inbox: {
              couldNotCheck: ["leases"],
              needsYou: [
                {
                  key: "w1/disconnected",
                  subject: "mac-1",
                  to: "/inbox/w1%2Fdisconnected",
                  tone: "error",
                  word: "disconnected",
                },
              ],
              problems: 1,
            },
          }}
        />,
      ),
    );

    expect(shown).toContain("Needs you");
    expect(shown).toContain("All in Inbox (1)");
    expect(shown).toContain("Could not check: leases");
    expect(shown).not.toContain("Nothing needs you");
  });

  it("links the workers table to Fleet and says 2 workers not read yet in the plural", () => {
    const shown = inConsole(
      <OverviewBody overview={{ ...quiet, capacity: [{ name: "iOS", notRead: 2, parts: [] }] }} />,
    );

    expect(shown).toContain('href="/fleet">Open Fleet</a>');
    expect(text(shown)).toContain("iOS 2 workers not read yet");
    expect(shown).toContain('aria-label="iOS: no devices"');
  });

  it("draws the workers with Fleet's table, every row and no pager, and notes capacity not read yet", () => {
    const html = inConsole(
      <OverviewBody
        overview={{
          ...quiet,
          capacity: [
            { name: "iOS", notRead: 1, parts: [] },
            {
              name: "Android",
              notRead: 0,
              parts: [
                { count: 2, kind: "leased", percent: 50, word: "leased" },
                { count: 2, kind: "offline", percent: 50, word: "offline" },
              ],
            },
          ],
          workers: Array.from({ length: 12 }, (_, index) => ({
            connection: "connected" as const,
            takesLeases: true,
            health: { tone: "ok" as const, word: "connected" },
            id: `w${index}`,
            meters: [],
            mono: false,
            name: `mac-${index}`,
            slots: [],
            slotsLabel: "No devices",
            to: `/fleet/w${index}`,
            updateFacts: { latestVersion: null, leased: 0, update: null },
          })),
        }}
      />,
    );

    const table = text(html);
    for (const header of ["Worker", "State", "Slots", "Use", "CPU", "Memory", "Disk"]) {
      expect(table).toContain(header);
    }
    expect(html).toContain('href="/fleet/w0"');
    expect(html).toContain('href="/fleet/w11"');
    expect(html).not.toContain("Workers pages");
    expect(text(html)).toContain("iOS 1 worker not read yet");
    expect(html).toContain('role="img" aria-label="Android: 2 leased, 2 offline"');
    expect(text(html)).toContain("2 leased 2 offline");
  });

  it("draws the range picker as a radio group of four with the chosen range checked, two chart panels and the Capacity panel", () => {
    const shown = inConsole(
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
        "Capacity · all workers",
      ]),
    );
    expect(headings).not.toContain("Device slots in use, last 6 hours");
  });

  it("shows the partial note above the tiles when the figures carry one, and no note otherwise", () => {
    const partial = text(
      inConsole(
        <OverviewBody
          overview={withFigures({ coversFrom: NOW - 90 * 60_000, partial: true })}
          range="1h"
          onRange={() => undefined}
        />,
      ),
    );
    const whole = text(
      inConsole(<OverviewBody overview={withFigures({})} range="1h" onRange={() => undefined} />),
    );

    expect(partial).toContain("Figures cover from today 10:30.");
    expect(partial.indexOf("Figures cover from")).toBeLessThan(partial.indexOf("Leased"));
    expect(whole).not.toContain("Figures cover from");
  });

  it("shows a refused stats read as one item after Workers and as one panel, and leaves the fleet's tiles and panels", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={overviewOf({
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
    for (const kept of ["Leased", "Waiting", "Ending soon", "Capacity", "Nothing needs you"]) {
      expect(shown, kept).toContain(kept);
    }
    expect(shown).toContain("No workers have connected.");
    for (const gone of ["Wait p95", "Leases held, last hour"]) {
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
      inConsole(<OverviewBody overview={stale} range="6h" onRange={() => undefined} />),
    );

    expect(shown.split("The stats are not allowed.")).toHaveLength(2);
    expect(shown.indexOf("The stats are not allowed.")).toBeLessThan(shown.indexOf("Wait p95"));
    expect(shown).toContain("Wait p95");
    expect(shown).toContain("Leases held, last 6 hours");
  });

  it("shows Loading… in the same two places while the stats read is loading", () => {
    const shown = text(
      inConsole(
        <OverviewBody
          overview={overviewOf({ now: NOW, requests: [], workers: [] })}
          range="1h"
          onRange={() => undefined}
        />,
      ),
    );

    expect(shown.split("Loading…")).toHaveLength(3);
    expect(shown).toContain("Leased");
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
    figures: { data: figuresOf(stats, "6h", NOW), kind: "ready" },
    now: NOW,
    requests: [],
    workers: [],
  });
}
