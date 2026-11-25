import { describe, expect, it } from "vitest";
import {
  request,
  createHarness,
  seedReady,
  flush,
  settle,
  seedShutdown,
} from "./test-lease-acquisition.js";

describe("LeaseAcquisitionCoordinator: what lease.granted reports", () => {
  const owner = (id: string) => ({ ownerId: id, requesterId: id });

  function granted(harness: Awaited<ReturnType<typeof createHarness>>) {
    const events: Array<{ requestId: string; source: string; leaseId: string }> = [];
    harness.bus.subscribe("lease.granted", (envelope) => events.push(envelope.payload));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    return { events, requested };
  }

  it.each([
    {
      name: "warm for a lease granted from a ready device",
      source: "warm",
      seed: async (harness) => {
        await seedReady(harness);
      },
    },
    {
      name: "booted for a lease granted after booting a shut-down device",
      source: "booted",
      seed: async (harness) => {
        await seedShutdown(harness);
      },
    },
    {
      name: "provisioned for a lease granted on a device provisioned for it",
      source: "provisioned",
      seed: async () => undefined,
    },
    {
      name: "provisioned when an eviction deleted a device and a new one was created",
      source: "provisioned",
      seed: async (harness) => {
        await seedReady(harness, { ...request, model: "iPhone SE" });
      },
    },
    {
      // why: with one running slot taken by a ready device of another model, the shut-down device
      // of the requested model can boot only after an eviction gives the slot back.
      name: "booted when an eviction shut a device down and a shut-down device was then booted",
      source: "booted",
      limits: { maxDevices: 2, maxRunning: 1 },
      seed: async (harness) => {
        await seedShutdown(harness);
        return seedReady(harness, { ...request, model: "iPhone SE" });
      },
      evictedLeavesReady: true,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    source: "warm" | "booted" | "provisioned";
    limits?: { maxDevices: number; maxRunning: number };
    seed: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<{ id: string } | void>;
    evictedLeavesReady?: boolean;
  }>)(
    "emits lease.granted with exactly the grant's device, lease, requester, request and platform, and source $name",
    async ({ source, limits, seed, evictedLeavesReady }) => {
      const harness = await createHarness(limits);
      const evicted = await seed(harness);
      const { events, requested } = granted(harness);

      const grant = await harness.coordinator.request(request, owner("agent"));

      expect(requested[0]).toMatch(/^req_/);
      expect(events).toEqual([
        {
          deviceId: grant.device.id,
          leaseId: grant.lease.id,
          platform: grant.device.spec.platform,
          requester: "agent",
          requestId: requested[0],
          source,
        },
      ]);
      if (evictedLeavesReady === true) {
        expect(
          harness.registry.snapshot.devices.find((device) => device.id === evicted?.id)?.state,
        ).not.toBe("ready");
      }
    },
  );

  it("gives a request refused as already-leased the id its admission would have minted, and emits no lease.requested for it", async () => {
    const harness = await createHarness({ maxDevices: 2, maxRunning: 2 });
    const first = await harness.coordinator.request(request, owner("agent"));
    const requested: string[] = [];
    harness.bus.subscribe("lease.requested", (envelope) =>
      requested.push(envelope.payload.requestId),
    );
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const mintedBefore = harness.requestIds.length;

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
    });

    expect(requested).toEqual([]);
    expect(harness.requestIds).toHaveLength(mintedBefore + 1);
    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "already-leased",
        requestId: `req_${harness.requestIds[mintedBefore]}`,
        requester: "agent",
      }),
    ]);

    const mintedBeforeAdmitted = harness.requestIds.length;
    await harness.coordinator.request(request, owner("other"));
    expect(harness.requestIds).toHaveLength(mintedBeforeAdmitted + 1);
    expect(requested).toEqual([`req_${harness.requestIds[mintedBeforeAdmitted]}`]);
  });

  it("gives a request refused as killed the id it would have been stored under", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    const rejected: Array<{ requestId: string; requester: string; reason: string }> = [];
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await expect(harness.coordinator.request(request, owner("agent"))).rejects.toMatchObject({
      name: "NukeCancelledError",
    });

    expect(rejected).toEqual([
      expect.objectContaining({
        reason: "killed",
        requestId: `req_${harness.requestIds[0]}`,
        requester: "agent",
      }),
    ]);
  });
});

describe("LeaseAcquisitionCoordinator probes (ADR 0021)", () => {
  const probe = (requesterId: string) => ({
    fleetRequestId: "req_gw1",
    noWait: true,
    ownerId: requesterId,
    requesterId,
  });

  it("emits lease.declined, and no lease.rejected, for a probe refused killed at admission", async () => {
    const harness = await createHarness();
    await harness.coordinator.beginMaintenance();
    const declined: unknown[] = [];
    const rejected: unknown[] = [];
    harness.bus.subscribe("lease.declined", (envelope) => declined.push(envelope.payload));
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));

    await expect(harness.coordinator.request(request, probe("gw:one"))).rejects.toMatchObject({
      name: "NukeCancelledError",
    });

    expect(declined).toEqual([
      {
        fleetRequestId: "req_gw1",
        reason: "killed",
        requestId: `req_${harness.requestIds[0]}`,
        requestSpec: request,
        requester: "gw:one",
      },
    ]);
    expect(rejected).toEqual([]);
  });

  it("emits lease.declined, and no lease.rejected, for a probe in progress when beginMaintenance runs", async () => {
    const harness = await createHarness();
    harness.driver.hangMakeReady();
    const declined: unknown[] = [];
    const rejected: unknown[] = [];
    harness.bus.subscribe("lease.declined", (envelope) => declined.push(envelope.payload));
    harness.bus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
    const acquisition = harness.coordinator.request(request, probe("gw:one"));
    void acquisition.catch(() => undefined);
    await settle();

    const maintenance = harness.coordinator.beginMaintenance();
    await flush();
    harness.driver.releaseMakeReady();
    await maintenance;

    await expect(acquisition).rejects.toMatchObject({ name: "NukeCancelledError" });
    expect(declined).toEqual([
      expect.objectContaining({ fleetRequestId: "req_gw1", reason: "killed", requester: "gw:one" }),
    ]);
    expect(rejected).toEqual([]);
    await harness.coordinator.endMaintenance();
  });
});
