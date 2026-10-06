import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { type LeaseRequestRecord, SerializedDecision, StartupRead } from "../core/index.js";
import { LeaseStartup } from "./lease-startup.js";

const restarted: LeaseRequestRecord = {
  createdAt: 1,
  id: "req_1",
  ownerId: "owner",
  request: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
  requesterId: "agent",
  state: "failed",
  failure: { code: "INTERNAL", message: "x" },
  settledAt: 2,
};

function harness(
  settled: readonly LeaseRequestRecord[],
  leases: { readonly ids: string[]; readonly notRunning: ReadonlySet<string> } = {
    ids: [],
    notRunning: new Set(),
  },
) {
  const order: string[] = [];
  const timerLeases: string[][] = [];
  const eventBus = new EventBus(new FakeClock(0));
  const events: { event: string; payload: unknown; module: string }[] = [];
  eventBus.subscribe("lease.rejected", (event) => {
    order.push(`event:${event.event}`);
    events.push({ event: event.event, payload: event.payload, module: event.module });
  });
  const failures: unknown[] = [];
  const reads: StartupRead[] = [];
  const startup = new LeaseStartup({
    decisions: new SerializedDecision(),
    eventBus,
    registry: {
      failOpenLeaseRequests: async (failure) => {
        order.push("settle");
        failures.push(failure);
        return settled;
      },
    },
    reconciler: {
      run: async (read) => {
        order.push("reconcile");
        reads.push(read);
        // The ending the real reconciler performs: a lease whose device is not running is gone.
        leases.ids.splice(
          0,
          leases.ids.length,
          ...leases.ids.filter((id) => !leases.notRunning.has(id)),
        );
      },
    },
    timers: {
      restoreExpiryTimers: async () => {
        order.push("timers");
        timerLeases.push([...leases.ids]);
      },
    },
  });
  return { events, failures, order, reads, startup, timerLeases };
}

describe("LeaseStartup", () => {
  it("settles every request the restart left open with daemon-restarted", async () => {
    const h = harness([restarted]);

    await h.startup.settleRequests();

    expect(h.failures).toEqual([
      {
        code: "INTERNAL",
        message:
          "The daemon restarted before this lease request settled; send it again with a new key",
      },
    ]);
    expect(h.order).toEqual(["settle", "event:lease.rejected"]);
    expect(h.events).toEqual([
      {
        event: "lease.rejected",
        payload: {
          reason: "daemon-restarted",
          requestId: "req_1",
          requestSpec: { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
          requester: "agent",
        },
        module: "lease-startup",
      },
    ]);
  });

  it("emits no lease.rejected when no request was left open", async () => {
    const h = harness([]);

    await h.startup.settleRequests();

    expect(h.order).toEqual(["settle"]);
  });

  it("runs the reconciler on the read it is given, then restores the expiry timers of only the leases it left", async () => {
    const h = harness([], {
      ids: ["lse_running", "lse_stopped"],
      notRunning: new Set(["lse_stopped"]),
    });
    const read = new StartupRead();

    await h.startup.reconcile(read);

    expect(h.order).toEqual(["reconcile", "timers"]);
    expect(h.timerLeases).toEqual([["lse_running"]]);
    expect(h.reads).toEqual([read]);
    expect(h.reads[0]).toBe(read);
  });
});
