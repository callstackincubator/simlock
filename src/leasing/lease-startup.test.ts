import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { type LeaseRequestRecord, SerializedDecision } from "../core/index.js";
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

function harness(settled: readonly LeaseRequestRecord[]) {
  const order: string[] = [];
  const eventBus = new EventBus(new FakeClock(0));
  const events: { event: string; payload: unknown; module: string }[] = [];
  eventBus.subscribe("lease.rejected", (event) => {
    order.push(`event:${event.event}`);
    events.push({ event: event.event, payload: event.payload, module: event.module });
  });
  const failures: unknown[] = [];
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
    timers: {
      restoreExpiryTimers: async () => {
        order.push("timers");
      },
    },
  });
  return { events, failures, order, startup };
}

describe("LeaseStartup", () => {
  it("settles every request the restart left open with daemon-restarted, then restores expiry timers", async () => {
    const h = harness([restarted]);

    await h.startup.run();

    expect(h.failures).toEqual([
      {
        code: "INTERNAL",
        message:
          "The daemon restarted before this lease request settled; send it again with a new key",
      },
    ]);
    expect(h.order).toEqual(["settle", "event:lease.rejected", "timers"]);
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

    await h.startup.run();

    expect(h.order).toEqual(["settle", "timers"]);
  });
});
