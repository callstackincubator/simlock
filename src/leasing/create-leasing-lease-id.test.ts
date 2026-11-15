import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, flush, settledOrPending } from "./test-create-leasing.js";

describe("createLeasing a lease ID chosen by the requester", () => {
  const roomy = {
    android: { maxDevices: 2, maxRunning: 2 },
    ios: { maxDevices: 3, maxRunning: 3 },
    maxRunning: 4,
  };

  function asking(requesterId: string, leaseId?: string, more: Record<string, unknown> = {}) {
    return {
      ownerId: requesterId,
      requesterId,
      ...(leaseId === undefined ? {} : { leaseId }),
      ...more,
    };
  }

  async function withWaiting(requesterId: string, leaseId: string) {
    const harness = await createHarness();
    await harness.engine.request(request, asking("holder"));
    void harness.engine.request(request, asking(requesterId, leaseId)).catch(() => undefined);
    await expect
      .poll(() =>
        harness.registry.leaseRequests().find((record) => record.requesterId === requesterId),
      )
      .toMatchObject({ state: "open" });
    return harness;
  }

  it("a lease request with leaseId gets a lease with exactly that ID", async () => {
    const harness = await createHarness();

    const grant = await harness.engine.request(request, asking("agent-1", "ad-7f3a"));

    expect(grant.lease.id).toBe("ad-7f3a");
    expect(grant.lease).toMatchObject({ idChosenByRequester: true });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual(["ad-7f3a"]);
  });

  it("a lease request without leaseId gets an lse_ ID as today", async () => {
    const harness = await createHarness();

    const grant = await harness.engine.request(request, asking("agent-1"));

    expect(grant.lease.id).toMatch(/^lse_/);
    expect(grant.lease).toMatchObject({ idChosenByRequester: false });
  });

  it("renew and release by a caller-chosen ID work", async () => {
    const harness = await createHarness();
    await harness.engine.request(request, asking("agent-1", "ad-7f3a"));

    await expect(harness.engine.renew("ad-7f3a", 5_000)).resolves.toMatchObject({
      id: "ad-7f3a",
      ttlMs: 5_000,
    });
    await harness.engine.release("ad-7f3a", "explicit");

    expect(harness.registry.snapshot.leases).toEqual([]);
    expect(
      harness.bus.replay().find((event) => event.event === "lease.released")?.payload,
    ).toMatchObject({
      leaseId: "ad-7f3a",
    });
  });

  it("MyID and myid are two different IDs", async () => {
    const harness = await createHarness({ limits: roomy });

    const first = await harness.engine.request(request, asking("agent-1", "myid"));
    const second = await harness.engine.request(request, asking("agent-2", "MyID"));

    expect([first.lease.id, second.lease.id]).toEqual(["myid", "MyID"]);
  });

  it("a second request for an ID held by an active lease fails with LEASE_ID_TAKEN", async () => {
    const harness = await createHarness({ limits: roomy });
    await harness.engine.request(request, asking("agent-1", "myid"));

    await expect(harness.engine.request(request, asking("agent-2", "myid"))).rejects.toMatchObject({
      leaseId: "myid",
      message: "lease ID myid is already in use",
      name: "LeaseIdTakenError",
    });
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual(["myid"]);
  });

  it("a second request for an ID held by a waiting request fails with LEASE_ID_TAKEN", async () => {
    const harness = await withWaiting("agent-2", "myid");

    const clash = harness.engine.request(request, asking("agent-3", "myid"));
    void clash.catch(() => undefined);

    // why: Settled at once: a request that was let in would wait for the one device instead.
    await expect(settledOrPending(clash)).resolves.toMatchObject({
      leaseId: "myid",
      name: "LeaseIdTakenError",
    });
  });

  it("a requester that already holds a lease gets REQUESTER_ALREADY_LEASED, not LEASE_ID_TAKEN, even when it repeats its own lease ID", async () => {
    const harness = await createHarness({ limits: roomy });
    const first = await harness.engine.request(request, asking("agent-1", "myid"));

    await expect(harness.engine.request(request, asking("agent-1", "myid"))).rejects.toMatchObject({
      existingLeaseId: first.lease.id,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("a LEASE_ID_TAKEN refusal emits lease.rejected with reason lease-id-taken", async () => {
    const harness = await createHarness({ limits: roomy });
    await harness.engine.request(request, asking("agent-1", "myid"));

    await harness.engine.request(request, asking("agent-2", "myid")).catch(() => undefined);

    const rejected = harness.bus.replay().filter((event) => event.event === "lease.rejected");
    expect(rejected.map((event) => event.payload)).toEqual([
      {
        reason: "lease-id-taken",
        requestId: expect.stringMatching(/^req_/),
        requester: "agent-2",
        requestSpec: request,
      },
    ]);
    expect(rejected.map((event) => event.module)).toEqual(["lease-acquisition-coordinator"]);
  });

  it("a caller re-sending a chosen lease id whose lease ended within the window gets LEASE_ENDED with the id and when it ended", async () => {
    type Harness = Awaited<ReturnType<typeof createHarness>>;
    const dayMs = 24 * 60 * 60_000;
    const freshDriver = () =>
      new FakeDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
    const cases: readonly {
      readonly name: string;
      readonly endIt: (harness: Harness, id: string) => Promise<Harness>;
      readonly outcome: "ended" | "granted" | "taken";
      readonly endedAt?: number;
      /** why: the first lease asks for no id (`generated`), or for one the retry does not use (`other`). */
      readonly asked?: "generated" | "other";
      /** why: rows left in `ended_lease_ids` once the retry is answered. */
      readonly rows?: number;
    }[] = [
      {
        name: "released, and another lease commits after it",
        endIt: async (harness) => {
          await harness.engine.release("myid", "explicit");
          harness.clock.advance(5_000);
          await harness.engine.request(request, asking("agent-3", "other"));
          return harness;
        },
        outcome: "ended",
        endedAt: 1_000,
      },
      {
        name: "expired",
        endIt: async (harness) => {
          harness.clock.advance(100_000);
          await flush();
          return harness;
        },
        outcome: "ended",
        endedAt: 101_000,
      },
      {
        name: "ended by nuke",
        endIt: async (harness) => {
          await harness.engine.nuke(false);
          return harness;
        },
        outcome: "ended",
        endedAt: 1_000,
      },
      {
        name: "ended at a daemon start",
        endIt: async (harness) => {
          const restarted = await createHarness({ driver: freshDriver(), state: harness.state });
          await restarted.engine.convergeRunningCapacity();
          return restarted;
        },
        outcome: "ended",
        endedAt: 1_000,
      },
      {
        name: "after a daemon restart",
        endIt: async (harness) => {
          await harness.engine.release("myid", "explicit");
          return createHarness({ driver: freshDriver(), state: harness.state });
        },
        outcome: "ended",
        endedAt: 1_000,
      },
      {
        name: "past the window",
        endIt: async (harness) => {
          await harness.engine.release("myid", "explicit");
          harness.clock.advance(dayMs + 1);
          return harness;
        },
        outcome: "granted",
        rows: 0,
      },
      {
        name: "a lease with a generated id",
        asked: "generated",
        endIt: async (harness, id) => {
          await harness.engine.release(id, "explicit");
          return harness;
        },
        outcome: "granted",
        rows: 0,
      },
      {
        name: "never used",
        asked: "other",
        endIt: async (harness) => harness,
        outcome: "granted",
      },
      { name: "still held", endIt: async (harness) => harness, outcome: "taken" },
    ];

    for (const { name, asked, endIt, outcome, endedAt, rows } of cases) {
      const first = await createHarness({ lease: { defaultTtlMs: 100_000 }, limits: roomy });
      const granted = await first.engine.request(
        request,
        asking("agent-1", asked === "generated" ? undefined : asked === "other" ? "other" : "myid"),
      );
      const harness = await endIt(first, granted.lease.id);
      const again = asked === "other" ? "myid" : granted.lease.id;
      harness.clock.advance(1_000);

      const retry = harness.engine.request(request, asking("agent-2", again));

      if (outcome === "ended") {
        await expect(retry, name).rejects.toMatchObject({
          code: "LEASE_ENDED",
          details: { endedAt, leaseId: "myid" },
          message: `Lease myid ended at ${new Date(endedAt ?? 0).toISOString()}; choose a new lease id`,
        });
      } else if (outcome === "taken") {
        await expect(retry, name).rejects.toMatchObject({ name: "LeaseIdTakenError" });
      } else {
        await expect(retry, name).resolves.toMatchObject({ lease: { id: again } });
      }
      if (rows !== undefined) {
        expect(
          harness.state.database.prepare("SELECT COUNT(*) AS n FROM ended_lease_ids").get(),
          name,
        ).toEqual({ n: rows });
      }
    }
  });

  it("lease.requested and lease.rejected requestSpec, and the status waiting spec, carry no leaseId", async () => {
    const harness = await withWaiting("agent-2", "myid");
    await settledOrPending(harness.engine.request(request, asking("agent-3", "myid")));

    const requested = harness.bus.replay().filter((event) => event.event === "lease.requested");
    const rejected = harness.bus.replay().filter((event) => event.event === "lease.rejected");
    expect(requested.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ requester: "agent-2", requestSpec: request }),
    );
    expect(
      rejected.map((event) => (event.payload as { requestSpec: unknown }).requestSpec),
    ).toEqual([request]);
    expect(harness.engine.waitingRequests().map((entry) => entry.spec)).toEqual([request]);
    expect(
      harness.registry.leaseRequests().find((record) => record.requesterId === "agent-2")?.request,
    ).toEqual(request);
  });

  it("a retry with the same idempotency key and the same leaseId replays the first answer", async () => {
    const harness = await createHarness();
    const asker = asking("agent-1", "myid", { idempotencyKey: "key-1" });
    const first = await harness.engine.request(request, asker);

    const retry = await harness.engine.request(request, asker);

    expect(retry).toEqual(first);
    expect(retry.lease.id).toBe("myid");
    expect(harness.registry.snapshot.leases).toHaveLength(1);
  });

  it.each([
    ["a different leaseId", "other"],
    ["no leaseId", undefined],
  ])(
    "a retry with the same idempotency key and %s fails with IDEMPOTENCY_CONFLICT",
    async (_name, retryId) => {
      const harness = await createHarness();
      await harness.engine.request(request, asking("agent-1", "myid", { idempotencyKey: "key-1" }));

      await expect(
        harness.engine.request(request, asking("agent-1", retryId, { idempotencyKey: "key-1" })),
      ).rejects.toMatchObject({ name: "IdempotencyConflictError" });
    },
  );

  it("a retry with the same idempotency key that adds a leaseId the first call did not have fails with IDEMPOTENCY_CONFLICT", async () => {
    const harness = await createHarness();
    const first = await harness.engine.request(
      request,
      asking("agent-1", undefined, { idempotencyKey: "key-1" }),
    );

    await expect(
      harness.engine.request(request, asking("agent-1", "myid", { idempotencyKey: "key-1" })),
    ).rejects.toMatchObject({ name: "IdempotencyConflictError" });
    await expect(
      harness.engine.request(request, asking("agent-1", undefined, { idempotencyKey: "key-1" })),
    ).resolves.toEqual(first);
    expect(harness.registry.snapshot.leases.map((lease) => lease.id)).toEqual([first.lease.id]);
  });

  it("after a daemon restart, an ID held only by a waiting request is accepted again", async () => {
    const before = await withWaiting("agent-2", "myid");
    // why: Started again with room to spare, so the only thing that could refuse "myid" is the ID.
    const after = await createHarness({ state: before.state, limits: roomy });
    await after.engine.convergeRunningCapacity();

    await expect(after.engine.request(request, asking("agent-3", "myid"))).resolves.toMatchObject({
      lease: { id: "myid" },
    });
  });
});
