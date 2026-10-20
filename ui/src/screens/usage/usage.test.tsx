import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Paging } from "../../ds";
import { usageOf } from "../../model/usage";
import type { UsageState } from "../../state/usage";
import { usageStatsEmptyOf, usageStatsFullOf } from "../../model/test-support";
import { UsageBody } from "./index";

const NOW = new Date(2026, 9, 15, 12, 0).getTime();

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const everything: Paging = {
  go: () => undefined,
  last: 1,
  page: 1,
  range: "1–3 of 3",
  resize: () => undefined,
  size: 25,
  sizes: [25, 50, 100],
  total: 3,
};

function shown(state: UsageState, range: "1h" | "6h" | "24h" | "7d" = "24h"): string {
  return renderToStaticMarkup(
    <UsageBody
      state={state}
      range={range}
      onRange={() => undefined}
      paging={{ requesters: everything, workers: everything }}
    />,
  );
}

function ready(over = {}): UsageState {
  return { data: usageOf(usageStatsFullOf(over), "24h", NOW), kind: "ready" };
}

describe("the Usage screen", () => {
  it("draws the picker with the chosen range checked, the tiles, and each table as a region named by its panel title", () => {
    const html = shown(ready(), "6h");

    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map(([tag]) => tag);
    expect(radios.map((tag) => /value="([^"]*)"/.exec(tag)?.[1])).toEqual([
      "1h",
      "6h",
      "24h",
      "7d",
    ]);
    expect(radios.filter((tag) => tag.includes("checked"))).toHaveLength(1);
    expect(radios.find((tag) => tag.includes("checked"))).toContain('value="6h"');
    const regions = [...html.matchAll(/<section[^>]*aria-labelledby="([^"]*)"/g)].map(
      ([, id]) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1],
    );
    expect(regions).toEqual([
      "Grants by source",
      "Durations",
      "Rejections by reason",
      "Use over the range",
      "Device incidents",
      "Per platform",
      "Per worker",
      "Per requester",
    ]);
    const body = text(html);
    expect(body).toContain("Held in total");
    for (const tile of [
      "Requests 214",
      "Granted 209",
      "Rejected 5",
      "Wait p95 38 s",
      "Held p50 4 min 2 s",
    ]) {
      expect(body, tile).toContain(tile);
    }
  });

  it("shows the partial note under the picker when the figures carry one, and none otherwise", () => {
    const partial = text(
      shown(ready({ coversFrom: new Date(2026, 9, 15, 9, 12).getTime(), partial: true })),
    );

    expect(partial).toContain("Figures cover from today 09:12.");
    expect(partial.indexOf("7 days")).toBeLessThan(partial.indexOf("Figures cover from"));
    expect(partial.indexOf("Figures cover from")).toBeLessThan(partial.indexOf("Requests 214"));
    expect(text(shown(ready()))).not.toContain("Figures cover from");
  });

  it("shows no declined, probes or failures.byEvent count", () => {
    const body = text(shown(ready()));

    expect(body).toContain("Requests 214");
    for (const hidden of ["777", "888", "999", "recovery-failed", "Declined", "Probes"]) {
      expect(body, hidden).not.toContain(hidden);
    }
  });

  it("says nothing was rejected, that no requests were made and that no workers are in the range when the answer has none", () => {
    const empty = usageStatsEmptyOf();
    const body = text(
      shown({ data: usageOf({ ...empty, workers: [] }, "24h", NOW), kind: "ready" }),
    );

    expect(body).toContain("No requests were rejected.");
    expect(body).toContain("No requests in this range.");
    expect(body).toContain("No workers in this range.");
  });

  it("shows a refused stats read's message in place of the figures", () => {
    const body = text(shown({ kind: "refused", message: "The stats are not allowed." }));

    expect(body).toContain("The stats are not allowed.");
    expect(body).not.toContain("Requests 214");
    expect(body).not.toContain("Grants by source");
  });

  it("shows Loading… while the stats read is loading", () => {
    const body = text(shown({ kind: "loading" }));

    expect(body).toContain("Loading…");
    expect(body).not.toContain("Grants by source");
  });

  it("keeps the last figures with the refusal above them when a read is refused after an answer", () => {
    const stale = {
      ...(ready() as Extract<UsageState, { kind: "ready" }>),
      refusal: "The stats are not allowed.",
    };
    const body = text(shown(stale));

    expect(body.split("The stats are not allowed.")).toHaveLength(2);
    expect(body.indexOf("The stats are not allowed.")).toBeLessThan(body.indexOf("Requests 214"));
    expect(body).toContain("Grants by source");
  });
});
