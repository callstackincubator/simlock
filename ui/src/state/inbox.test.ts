import { describe, expect, it } from "vitest";

import { ApiError } from "../data/api";
import type { LeaseList } from "../model/leases";
import type { WorkerList } from "../model/workers";
import { inboxReadsOf } from "./inbox";

const NO_LEASES = { leases: [] } as unknown as LeaseList;
const NO_WORKERS = { workers: [] } as unknown as WorkerList;
const DOWN = new ApiError(500, undefined, "down");

describe("what the Inbox could not check", () => {
  it("names nothing when every read answered", () => {
    const reads = inboxReadsOf(
      { data: { requests: [] } },
      { data: NO_LEASES },
      {},
      { data: NO_WORKERS },
    );

    expect(reads.couldNotCheck).toEqual([]);
  });

  it("names the waiting requests when that read failed before any answer, and counts none", () => {
    const reads = inboxReadsOf({ error: DOWN }, { data: NO_LEASES }, {}, { data: NO_WORKERS });

    expect(reads.couldNotCheck).toEqual(["waiting requests"]);
    expect(reads.waiting).toEqual({ data: { requests: [] }, kind: "ready" });
  });

  it("names the waiting requests when that read failed after an earlier answer, and keeps the answer", () => {
    const held = { requests: [] };
    const reads = inboxReadsOf(
      { data: held, error: DOWN },
      { data: NO_LEASES },
      {},
      { data: NO_WORKERS },
    );

    expect(reads.couldNotCheck).toEqual(["waiting requests"]);
    expect(reads.waiting).toEqual({ data: held, kind: "ready", refusal: "down" });
  });

  it("names the leases when that read failed, before any answer and after one", () => {
    expect(
      inboxReadsOf({ data: { requests: [] } }, { error: DOWN }, {}, { data: NO_WORKERS })
        .couldNotCheck,
    ).toEqual(["leases"]);
    expect(
      inboxReadsOf(
        { data: { requests: [] } },
        { data: NO_LEASES, error: DOWN },
        {},
        { data: NO_WORKERS },
      ).couldNotCheck,
    ).toEqual(["leases"]);
  });

  it("names both, waiting requests first", () => {
    expect(
      inboxReadsOf({ error: DOWN }, { error: DOWN }, {}, { data: NO_WORKERS }).couldNotCheck,
    ).toEqual(["waiting requests", "leases"]);
  });

  it("names nothing for a daemon that keeps no queue of its own", () => {
    const unsupported = new ApiError(501, "UNSUPPORTED_IN_WORKER_MODE", "no queue here");
    const reads = inboxReadsOf(
      { error: unsupported },
      { data: NO_LEASES },
      {},
      { data: NO_WORKERS },
    );

    expect(reads.couldNotCheck).toEqual([]);
    expect(reads.waiting).toEqual({ data: { requests: [] }, kind: "ready" });
  });

  it("counts no leases when that read failed after an earlier answer", () => {
    const held = { leases: [{ id: "held" }] } as unknown as LeaseList;
    const reads = inboxReadsOf(
      { data: { requests: [] } },
      { data: held, error: DOWN },
      {},
      { data: NO_WORKERS },
    );

    expect(reads.leases).toBeUndefined();
  });

  it("names the workers when that read failed after an earlier answer, and keeps the answer", () => {
    const reads = inboxReadsOf(
      { data: { requests: [] } },
      { data: NO_LEASES },
      {},
      { data: NO_WORKERS, error: DOWN },
    );

    expect(reads.couldNotCheck).toEqual(["workers"]);
    expect(reads.workers).toEqual({ data: NO_WORKERS, kind: "ready", refusal: "down" });
  });
});
