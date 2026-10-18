import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
  chartSummary: "",
  minutes: [],
  platforms: [],
  tiles: [],
  workers: [],
};

describe("the overview screen", () => {
  it("says so in one line where a fleet has no workers, no lease count, nothing needs attention and nothing happened", () => {
    const shown = text(renderToStaticMarkup(<OverviewBody overview={quiet} />));

    expect(shown).toContain("No workers have connected.");
    expect(shown).toContain("Not reported.");
    expect(shown).not.toContain("Minute by minute");
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
              to: "/workers/w1",
            },
            {
              health: { tone: "warn", word: "starting" },
              id: "w2",
              name: "mac-mini-02",
              slots: [],
              slotsLabel: "Not reported",
              to: "/workers/w2",
            },
          ],
        }}
      />,
    );

    expect(html).toContain('class="status-dot status-dot-warn" role="img" aria-label="memory 88%"');
    expect(html).toContain('role="img" aria-label="1 leased, 1 free"');
    expect(html).toContain('href="/workers/w1"');
    expect(text(html)).not.toContain("memory 88%");
    expect(html).toContain('<td data-label="Leases" class="num"><span class="muted">—</span></td>');
    expect(html).toContain('<span class="muted">—</span></span></p>');
    expect(text(html)).toContain("2 of 4 running");
    expect(html.match(/class="share-bar"/g)).toHaveLength(1);
  });
});
