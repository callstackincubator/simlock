import { describe, expect, it } from "vitest";

import { activityView, NO_FILTER, OTHER_WORKER, readFilter, writeFilter } from "./activity-view";
import type { ConsoleEvent } from "./events";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

function event(n: number, name: string, minutes: number, workerId?: string): ConsoleEvent {
  return {
    event: name,
    id: `evt_${n}`,
    payload: workerId === undefined ? {} : { workerId },
    seq: n,
    timestamp: NOW - minutes * 60_000,
  } as ConsoleEvent;
}

const EVENTS = [
  event(1, "lease.granted", 1, "wrk_a"),
  event(2, "queue.changed", 2),
  event(3, "device.quarantined", 3, "wrk_a"),
  event(4, "baseline.built", 4, "wrk_b"),
  event(5, "component.ready", 5),
  event(6, "lease.renewed", 180, "wrk_b"),
];

function view(filter = NO_FILTER, range: "1h" | "6h" = "1h", search = "") {
  return activityView({ events: EVENTS, filter, now: NOW, range, search, workers: [] });
}

describe("the Activity view", () => {
  it("keeps the events of the range and counts each kind, with component events under Other", () => {
    const shown = view();

    expect(shown.rows).toHaveLength(5);
    expect(Object.fromEntries(shown.facets.kinds.map((kind) => [kind.value, kind.count]))).toEqual({
      baseline: 1,
      device: 1,
      lease: 1,
      other: 1,
      queue: 1,
      worker: 0,
    });
    expect(view(NO_FILTER, "6h").rows).toHaveLength(6);
  });

  it("matches within a facet by OR and between facets by AND, and Problems only keeps warn and error", () => {
    expect(view({ ...NO_FILTER, kinds: ["lease", "queue"] }).rows).toHaveLength(2);
    expect(view({ kinds: ["lease", "device"], problems: true, workers: [] }).rows).toHaveLength(1);
    expect(view({ ...NO_FILTER, workers: [OTHER_WORKER] }).rows.map((row) => row.name)).toEqual([
      "queue.changed",
      "component.ready",
    ]);
  });

  it("counts a facet without its own selection, so a box says what ticking it adds", () => {
    const shown = view({ ...NO_FILTER, kinds: ["lease"] });

    expect(shown.facets.kinds.find((kind) => kind.value === "queue")?.count).toBe(1);
    expect(shown.facets.workers.find((worker) => worker.value === "wrk_a")?.count).toBe(1);
    expect(shown.facets.problems.count).toBe(0);
  });

  it("searches the name and the summary, and the chart counts what the feed shows", () => {
    const shown = view(NO_FILTER, "1h", "GRANTED");

    expect(shown.rows.map((row) => row.name)).toEqual(["lease.granted"]);
    expect(shown.chart.summary).toContain("1 event in the last hour");
  });

  it("reads and writes the facets in the URL, legacy subjects included", () => {
    const filter = readFilter("?kind=lease&kind=queue&state=problems&worker=&worker=wrk_a&q=x");

    expect(filter).toEqual({ kinds: ["lease", "queue"], problems: true, workers: ["", "wrk_a"] });
    expect(writeFilter("?q=x&range=6h", filter)).toBe(
      "?q=x&range=6h&kind=lease&kind=queue&state=problems&worker=&worker=wrk_a",
    );
    expect(readFilter("?subject=component").kinds).toEqual(["other"]);
    expect(readFilter("?subject=lease").kinds).toEqual(["lease"]);
    expect(readFilter("?subject=nonsense").kinds).toEqual([]);
  });
});
