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
  it("says so in one line where a fleet has no workers, nothing needs attention and nothing happened", () => {
    const shown = text(renderToStaticMarkup(<OverviewBody overview={quiet} />));

    expect(shown).toContain("No workers have connected.");
    expect(shown).toContain("Nothing needs attention.");
    expect(shown).toContain("No events in the last hour.");
  });

  it("names each worker's health in its square, and its devices in words beside the slots", () => {
    const html = renderToStaticMarkup(
      <OverviewBody
        overview={{
          ...quiet,
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
          ],
        }}
      />,
    );

    expect(html).toContain('class="status-dot status-dot-warn" role="img" aria-label="memory 88%"');
    expect(html).toContain('role="img" aria-label="1 leased, 1 free"');
    expect(html).toContain('href="/workers/w1"');
    expect(text(html)).not.toContain("memory 88%");
  });
});
