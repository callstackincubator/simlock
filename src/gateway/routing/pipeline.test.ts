import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";
import { type FilterStage, type RankStage, runStages } from "./pipeline.js";

const REQUEST = { model: "iPhone 17", platform: "ios" as const };

function view(id: string): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: 1,
    leases: [],
  };
}

/** A rank that scores each worker from a table, so a test can state every score outright. */
function rank(name: string, scores: Record<string, number>, settles = false): RankStage {
  return { kind: "rank", name, score: (worker) => scores[worker.id] ?? 0, settles };
}

function only(...ids: string[]): FilterStage {
  return { keeps: (worker) => ids.includes(worker.id), kind: "filter" };
}

describe("routing pipeline", () => {
  const workers = [view("wrk_a"), view("wrk_b"), view("wrk_c")];

  it("a rank stage whose best score is zero changes nothing", () => {
    const decides = rank("decides", { wrk_a: 1, wrk_b: 1, wrk_c: 1 });
    const abstains = rank("abstains", { wrk_a: 0, wrk_b: -3, wrk_c: 0 });
    const narrows = rank("narrows", { wrk_b: 2, wrk_c: 2 });

    // `abstains` would drop wrk_b if it acted on its scores; it does not, so `narrows` still sees
    // wrk_b and wrk_c, and the deciding stage stays `narrows` rather than `abstains`.
    expect(runStages([decides, abstains, narrows], REQUEST, workers)).toEqual({
      stage: "narrows",
      workerId: "wrk_b",
    });
    expect(runStages([decides, abstains], REQUEST, workers)).toEqual({
      stage: "decides",
      workerId: "wrk_a",
    });
  });

  it("no worker is picked when no rank stage decided", () => {
    const abstains = rank("abstains", {});

    expect(runStages([], REQUEST, workers)).toBeUndefined();
    expect(runStages([only("wrk_a", "wrk_b", "wrk_c")], REQUEST, workers)).toBeUndefined();
    expect(runStages([abstains], REQUEST, workers)).toBeUndefined();
  });

  it("a settling rank that decides ends the walk, also when it removes no worker", () => {
    const settlesKeepingAll = rank("settles", { wrk_a: 1, wrk_b: 1, wrk_c: 1 }, true);
    const later = rank("later", { wrk_c: 5 });

    expect(runStages([settlesKeepingAll, later], REQUEST, workers)).toEqual({
      stage: "settles",
      workerId: "wrk_a",
    });
    // Control: the same pair without settling lets `later` decide.
    const keepsAll = rank("keeps-all", { wrk_a: 1, wrk_b: 1, wrk_c: 1 });
    expect(runStages([keepsAll, later], REQUEST, workers)).toEqual({
      stage: "later",
      workerId: "wrk_c",
    });
  });

  it("a settling rank that abstains does not end the walk", () => {
    const settlesAbstaining = rank("settles", {}, true);
    const later = rank("later", { wrk_c: 5 });

    expect(runStages([settlesAbstaining, later], REQUEST, workers)).toEqual({
      stage: "later",
      workerId: "wrk_c",
    });
  });

  it("with one worker and a deciding rank, that worker is picked and that rank is the deciding stage", () => {
    const decides = rank("decides", { wrk_b: 1 });

    expect(runStages([decides], REQUEST, [view("wrk_b")])).toEqual({
      stage: "decides",
      workerId: "wrk_b",
    });
  });

  it("names the last rank that removed a worker, not a later rank that decided without removing any", () => {
    const removes = rank("removes", { wrk_b: 1, wrk_c: 1 });
    const keepsBoth = rank("keeps-both", { wrk_b: 3, wrk_c: 3 });

    expect(runStages([removes, keepsBoth], REQUEST, workers)).toEqual({
      stage: "removes",
      workerId: "wrk_b",
    });
  });

  it("does not credit a filter with the decision, even when it removed workers", () => {
    const decides = rank("decides", { wrk_a: 1, wrk_b: 1, wrk_c: 1 });

    expect(runStages([only("wrk_c"), decides], REQUEST, workers)).toEqual({
      stage: "decides",
      workerId: "wrk_c",
    });
  });

  it("picks the first remaining worker in ascending worker id, whatever order the views came in", () => {
    const decides = rank("decides", { wrk_a: 1, wrk_b: 1, wrk_c: 1 });

    expect(runStages([decides], REQUEST, [...workers].reverse())).toEqual({
      stage: "decides",
      workerId: "wrk_a",
    });
  });
});
