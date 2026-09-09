import { describe, expect, it } from "vitest";

import type { Logger } from "../ports/index.js";
import { FleetLeaseIndex, type WorkerReportedLease } from "./lease-index.js";

const PREFIX = "gw:instance-1:";

/** Records every `warn` call. */
class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  error(): void {}
  child(): Logger {
    return this;
  }
}

function reported(id: string, overrides: Partial<WorkerReportedLease> = {}): WorkerReportedLease {
  return {
    grantedAt: 1,
    id,
    ownerId: "alice-principal",
    requesterId: `${PREFIX}alice`,
    ...overrides,
  };
}

function entry(overrides: Partial<Parameters<FleetLeaseIndex["add"]>[0]> = {}) {
  return {
    gatewayLeaseId: "wrk_1.lse_1",
    grantedAt: 1,
    ownerId: "alice-principal",
    requesterId: "alice",
    workerId: "wrk_1",
    workerLeaseId: "lse_1",
    ...overrides,
  };
}

describe("FleetLeaseIndex", () => {
  describe("add / resolve / lookups", () => {
    it("resolves an entry by gateway id, by (workerId, workerLeaseId), by ownerId and by requesterId", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      expect(index.resolve("wrk_1.lse_1")).toEqual(entry());
      expect(index.findByWorkerLease("wrk_1", "lse_1")).toEqual(entry());
      expect(index.findByWorkerLease("wrk_1", "lse_other")).toBeUndefined();
      expect(index.ownerId("wrk_1.lse_1")).toBe("alice-principal");
      expect(index.leaseRequesterId("wrk_1.lse_1")).toBe("alice");
      expect(index.existingLeaseId("alice")).toBe("wrk_1.lse_1");
      expect(index.all()).toEqual([entry()]);
    });

    it("replaces rather than duplicates when the same gateway id is added twice", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());
      index.add(entry({ ownerId: "someone-else" }));

      expect(index.all()).toHaveLength(1);
      expect(index.ownerId("wrk_1.lse_1")).toBe("someone-else");
    });
  });

  describe("remove / removeByWorkerLease", () => {
    it("remove forgets an entry by gateway id and is a no-op for an unknown one", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      expect(index.remove("wrk_1.lse_1")).toEqual(entry());
      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
      expect(index.existingLeaseId("alice")).toBeUndefined();
      expect(index.remove("wrk_1.lse_1")).toBeUndefined();
    });

    it("removeByWorkerLease finds and forgets atomically, returning the entry it removed", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      const removed = index.removeByWorkerLease("wrk_1", "lse_1");
      expect(removed).toEqual(entry());
      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
      expect(index.removeByWorkerLease("wrk_1", "lse_1")).toBeUndefined();
    });

    it("does not let removing one requester's entry evict a different entry that raced it onto the same requester slot", () => {
      // `#byRequester` is keyed by requesterId, one entry deep -- removing an id only clears the
      // requester slot when it still points at *that* gateway id, which is what protects a
      // requester who released and immediately re-leased from having the new lease's admission
      // slot wiped by the old one's removal landing late.
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry({ gatewayLeaseId: "wrk_1.lse_1", workerLeaseId: "lse_1" }));
      index.remove("wrk_1.lse_1");
      index.add(entry({ gatewayLeaseId: "wrk_1.lse_2", workerLeaseId: "lse_2" }));

      // A late `remove` for the first (already-gone) id must not disturb the second.
      index.remove("wrk_1.lse_1");
      expect(index.existingLeaseId("alice")).toBe("wrk_1.lse_2");
    });
  });

  describe("rebuildFromWorker: additions", () => {
    it("adds every gateway-issued lease a snapshot reports that the index does not already know", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.rebuildFromWorker("wrk_1", [
        reported("lse_1"),
        reported("lse_2", { requesterId: `${PREFIX}bob`, ownerId: "bob-principal" }),
      ]);

      expect(index.resolve("wrk_1.lse_1")).toMatchObject({
        ownerId: "alice-principal",
        requesterId: "alice",
      });
      expect(index.resolve("wrk_1.lse_2")).toMatchObject({
        ownerId: "bob-principal",
        requesterId: "bob",
      });
    });

    it("skips a worker's own local lease -- one whose requesterId does not carry this gateway's prefix", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.rebuildFromWorker("wrk_1", [reported("lse_local", { requesterId: "local-agent" })]);

      expect(index.resolve("wrk_1.lse_local")).toBeUndefined();
      expect(index.all()).toEqual([]);
    });

    it("does not overwrite an entry it already has with the same snapshot's own copy", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry({ ownerId: "granted-owner" }));

      // A worker's own view reports the same lease with a *different* ownerId -- if this ever
      // happened it would be the worker disagreeing with what the gateway itself granted, not
      // new information the rebuild should trust over the grant.
      index.rebuildFromWorker("wrk_1", [reported("lse_1", { ownerId: "different-owner" })]);

      expect(index.ownerId("wrk_1.lse_1")).toBe("granted-owner");
    });
  });

  describe("rebuildFromWorker: reconciliation (C3, round 2 review)", () => {
    it("removes an entry missing for two consecutive snapshots -- the worker restarted or expired the lease while the uplink was down", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      // First snapshot after reconnect: the worker no longer reports this lease at all. Without
      // C3's fix this is where the old upsert-only index would stop -- the entry survives
      // forever, and `agent-1`'s next request is refused REQUESTER_ALREADY_LEASED against a
      // lease that exists nowhere.
      index.rebuildFromWorker("wrk_1", []);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();
      expect(index.existingLeaseId("alice")).toBe("wrk_1.lse_1");

      // Second consecutive snapshot still does not report it -- now it is forgotten.
      index.rebuildFromWorker("wrk_1", []);
      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
      expect(index.existingLeaseId("alice")).toBeUndefined();
    });

    it("does not evict an entry that reappears in the very next snapshot -- the one-generation grace window a grant racing a refresh needs", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      // A single missed snapshot -- the exact shape of a refresh that started before this
      // gateway's own grant landed on the worker (the race `rebuildFromWorker`'s own doc comment
      // describes) -- must not be enough to evict on its own.
      index.rebuildFromWorker("wrk_1", []);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();

      // The lease is reported again on the very next snapshot: the miss really was a one-off,
      // and the entry survives indefinitely from here, not just for one more generation.
      index.rebuildFromWorker("wrk_1", [reported("lse_1")]);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();

      index.rebuildFromWorker("wrk_1", []);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();
      index.rebuildFromWorker("wrk_1", []);
      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
    });

    it("never removes an entry attributed to a different worker", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(
        entry({ gatewayLeaseId: "wrk_1.lse_1", workerId: "wrk_1", workerLeaseId: "lse_1" }),
      );
      index.add(
        entry({ gatewayLeaseId: "wrk_2.lse_1", workerId: "wrk_2", workerLeaseId: "lse_1" }),
      );

      index.rebuildFromWorker("wrk_1", []);
      index.rebuildFromWorker("wrk_1", []);

      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
      expect(index.resolve("wrk_2.lse_1")).toBeDefined();
    });
  });

  describe("removeByWorkerLease resurrection (C1, round 2 review)", () => {
    it("logs when a snapshot re-reports a lease removeByWorkerLease just forgot, instead of silently resurrecting it unremarked", () => {
      const logger = new RecordingLogger();
      const index = new FleetLeaseIndex(PREFIX, logger);
      index.add(entry());

      // The worker's own relayed `lease.expired`/`lease.released` forgets it...
      index.removeByWorkerLease("wrk_1", "lse_1");
      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();

      // ...but a snapshot that started gathering data before that fact landed completes after
      // it and still reports the same worker lease id. The worker is the source of truth, so
      // the entry is still re-added (a caller must not lose a lease the worker still holds)...
      index.rebuildFromWorker("wrk_1", [reported("lse_1")]);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();

      // ...but this is not an ordinary addition, and round 2 flagged silently swallowing it.
      expect(
        logger.warnings.some(
          (warning) =>
            warning.fields?.gatewayLeaseId === "wrk_1.lse_1" && warning.fields.workerId === "wrk_1",
        ),
      ).toBe(true);
    });

    it("does not warn for an ordinary addition that was never removed by a relayed event", () => {
      const logger = new RecordingLogger();
      const index = new FleetLeaseIndex(PREFIX, logger);

      index.rebuildFromWorker("wrk_1", [reported("lse_1")]);

      expect(logger.warnings).toEqual([]);
    });
  });

  describe("forgetWorker", () => {
    it("drops every entry attributed to the forgotten worker, and no other", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(
        entry({ gatewayLeaseId: "wrk_1.lse_1", workerId: "wrk_1", workerLeaseId: "lse_1" }),
      );
      index.add(
        entry({
          gatewayLeaseId: "wrk_2.lse_1",
          workerId: "wrk_2",
          workerLeaseId: "lse_1",
          requesterId: "bob",
        }),
      );

      index.forgetWorker("wrk_1");

      expect(index.resolve("wrk_1.lse_1")).toBeUndefined();
      expect(index.existingLeaseId("alice")).toBeUndefined();
      expect(index.resolve("wrk_2.lse_1")).toBeDefined();
    });

    it("starts reconciliation over for a worker id that reconnects after being forgotten, rather than inheriting a stale generation", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());
      index.rebuildFromWorker("wrk_1", []); // one miss recorded, entry still protected
      index.forgetWorker("wrk_1"); // the worker's view disappeared entirely (retention)

      // The same worker id reconnects and immediately reports the lease again (a worker that
      // never actually lost it -- only the gateway's view of it lapsed). A stale one-miss
      // generation surviving `forgetWorker` would have no way to hurt this case since the entry
      // itself is gone too, but the fresh add below must not be evicted by leftover bookkeeping.
      index.rebuildFromWorker("wrk_1", [reported("lse_1")]);
      index.rebuildFromWorker("wrk_1", [reported("lse_1")]);
      expect(index.resolve("wrk_1.lse_1")).toBeDefined();
    });
  });

  describe("project", () => {
    it("rewrites a recognized lease's id/requesterId and attaches worker, passing through an unrecognized one with only workerId added", () => {
      const index = new FleetLeaseIndex(PREFIX);
      index.add(entry());

      const projected = index.project(
        { id: "lse_1", requesterId: `${PREFIX}alice` },
        "wrk_1",
        "Alice's Mac",
      );
      expect(projected).toEqual({
        id: "wrk_1.lse_1",
        requesterId: "alice",
        workerId: "wrk_1",
        worker: { id: "wrk_1", label: "Alice's Mac" },
      });

      const passthrough = index.project(
        { id: "lse_local", requesterId: "local-agent" },
        "wrk_1",
        undefined,
      );
      expect(passthrough).toEqual({
        id: "lse_local",
        requesterId: "local-agent",
        workerId: "wrk_1",
      });
    });
  });

  describe("requesterPrefix", () => {
    it("exposes exactly the prefix it was constructed with", () => {
      expect(new FleetLeaseIndex(PREFIX).requesterPrefix).toBe(PREFIX);
    });
  });
});
