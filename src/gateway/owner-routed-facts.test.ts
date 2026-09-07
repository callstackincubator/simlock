import { describe, expect, it } from "vitest";

import { EventBus, type EventMap } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { GatewayOwnerRoutedFacts, type OwnerRoutedFact } from "./owner-routed-facts.js";

const PREFIX = "gw:instance-1:";

/** `WorkerLink#onWorkerEvent`'s own relay shape: the worker's real event, with `workerId` added.
 * H11 (round 2 review): the payload's own `ownerId` is *not* generally "the gateway's own uplink
 * principal, never a fleet client's" -- for a gateway-issued lease the worker stores the real
 * fleet owner verbatim (ADR §27a) and echoes it back honestly in the ordinary case. The reason
 * this class resolves `ownerId` from `FleetLeaseIndex` instead of the relayed field anyway is
 * that the field is a value round-tripped through a machine this gateway does not control, not
 * one it minted itself -- untrusted by construction, exactly like `FleetLeaseCoordinator`'s own
 * H6 fix distrusts the same echo on the grant path. This test's own scenario below (the payload
 * naming the gateway's uplink principal) is one way that echo can go wrong, not the only one. */
function relay<Event extends "lease.expired" | "lease.released">(
  event: Event,
  payload: EventMap[Event] & { readonly workerId: string },
): [Event, EventMap[Event]] {
  return [event, payload as unknown as EventMap[Event]];
}

describe("GatewayOwnerRoutedFacts", () => {
  it("routes a relayed lease-lost fact to the true fleet owner, never to the other requester holding a lease on the same worker", () => {
    const eventBus = new EventBus(new FakeClock(1_000));
    const leaseIndex = new FleetLeaseIndex(PREFIX);
    leaseIndex.add({
      gatewayLeaseId: "wrk_1.lse_alice",
      grantedAt: 1,
      ownerId: "alice-principal",
      requesterId: "alice",
      workerId: "wrk_1",
      workerLeaseId: "lse_alice",
    });
    leaseIndex.add({
      gatewayLeaseId: "wrk_1.lse_bob",
      grantedAt: 1,
      ownerId: "bob-principal",
      requesterId: "bob",
      workerId: "wrk_1",
      workerLeaseId: "lse_bob",
    });
    const facts = new GatewayOwnerRoutedFacts(eventBus, leaseIndex);
    const received: OwnerRoutedFact[] = [];
    facts.subscribe((fact) => received.push(fact));

    const [event, payload] = relay("lease.expired", {
      deviceId: "dev_1",
      leaseId: "lse_alice",
      // The relayed payload's own `ownerId` -- one thing a worker could echo back that is
      // definitely wrong for this lease (it names the gateway's own uplink principal, not
      // Alice). A correct implementation never reads this field at all; it resolves `ownerId`
      // from the index instead, regardless of what the payload happens to say.
      ownerId: "gw:instance-1",
      workerId: "wrk_1",
    });
    eventBus.emit(event, payload, "lease-lifecycle");

    expect(received).toEqual([
      {
        deviceId: "dev_1",
        leaseId: "wrk_1.lse_alice",
        ownerId: "alice-principal",
        reason: "expired",
        type: "lease-lost",
      },
    ]);
    // Bob's own lease is untouched by Alice's expiry -- a session comparing its principal against
    // this one fact's `ownerId` ("alice-principal") would never match Bob's, and no second fact
    // was emitted for him at all.
    expect(leaseIndex.resolve("wrk_1.lse_bob")).toBeDefined();
    // Alice's own entry is now gone: the lease actually ended, so a subsequent renew/release/exec
    // against it correctly finds nothing.
    expect(leaseIndex.resolve("wrk_1.lse_alice")).toBeUndefined();
  });

  it("emits nothing for a worker's own local lease -- one this gateway never issued and has no fact to relay for", () => {
    const eventBus = new EventBus(new FakeClock(1_000));
    const leaseIndex = new FleetLeaseIndex(PREFIX);
    // The index knows nothing about "lse_local" -- exactly the case for a lease a local agent on
    // the worker holds, which this gateway never forwarded.
    const facts = new GatewayOwnerRoutedFacts(eventBus, leaseIndex);
    const received: OwnerRoutedFact[] = [];
    facts.subscribe((fact) => received.push(fact));

    const [event, payload] = relay("lease.released", {
      deviceId: "dev_2",
      leaseId: "lse_local",
      ownerId: "local-agent",
      reason: "explicit",
      workerId: "wrk_1",
    });
    eventBus.emit(event, payload, "lease-lifecycle");

    expect(received).toEqual([]);
  });

  it("resolves device-unhealthy the same way, without removing the lease (it is still active)", () => {
    const eventBus = new EventBus(new FakeClock(1_000));
    const leaseIndex = new FleetLeaseIndex(PREFIX);
    leaseIndex.add({
      gatewayLeaseId: "wrk_1.lse_alice",
      grantedAt: 1,
      ownerId: "alice-principal",
      requesterId: "alice",
      workerId: "wrk_1",
      workerLeaseId: "lse_alice",
    });
    const facts = new GatewayOwnerRoutedFacts(eventBus, leaseIndex);
    const received: OwnerRoutedFact[] = [];
    facts.subscribe((fact) => received.push(fact));

    eventBus.emit(
      "device.crash-detected",
      {
        deviceId: "dev_1",
        leaseId: "lse_alice",
        observed: "stopped",
        platform: "ios",
        workerId: "wrk_1",
      } as unknown as EventMap["device.crash-detected"],
      "lease-health-monitor",
    );

    expect(received).toEqual([
      {
        deviceId: "dev_1",
        leaseId: "wrk_1.lse_alice",
        ownerId: "alice-principal",
        type: "device-unhealthy",
      },
    ]);
    expect(leaseIndex.resolve("wrk_1.lse_alice")).toBeDefined();
  });

  // H10 (round 2 review): the suite's own title used to claim this branch too ("device-unhealthy/
  // device-recovered the same way"), but only ever emitted device.crash-detected -- the
  // device-recovered branch (own-routed-facts.ts's "device.recovered" subscription) was correct
  // by inspection but never actually exercised.
  it("resolves device-recovered the same way, without removing the lease (it is still active)", () => {
    const eventBus = new EventBus(new FakeClock(1_000));
    const leaseIndex = new FleetLeaseIndex(PREFIX);
    leaseIndex.add({
      gatewayLeaseId: "wrk_1.lse_alice",
      grantedAt: 1,
      ownerId: "alice-principal",
      requesterId: "alice",
      workerId: "wrk_1",
      workerLeaseId: "lse_alice",
    });
    const facts = new GatewayOwnerRoutedFacts(eventBus, leaseIndex);
    const received: OwnerRoutedFact[] = [];
    facts.subscribe((fact) => received.push(fact));

    eventBus.emit(
      "device.recovered",
      {
        attempts: 2,
        deviceId: "dev_1",
        duration: 1_500,
        leaseId: "lse_alice",
        workerId: "wrk_1",
      } as unknown as EventMap["device.recovered"],
      "lease-health-monitor",
    );

    expect(received).toEqual([
      {
        attempts: 2,
        deviceId: "dev_1",
        leaseId: "wrk_1.lse_alice",
        ownerId: "alice-principal",
        type: "device-recovered",
      },
    ]);
    expect(leaseIndex.resolve("wrk_1.lse_alice")).toBeDefined();
  });
});
