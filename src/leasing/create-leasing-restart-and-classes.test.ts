import { describe, expect, it, vi } from "vitest";
import { UnknownLeaseError } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { request, createHarness, seedReady, flush } from "./test-create-leasing.js";

describe("createLeasing restart recovery of stored lease requests", () => {
  async function restartWithAgentQueued(idempotencyKey?: string) {
    const before = await createHarness();
    await before.engine.request(request, { ownerId: "holder", requesterId: "holder" });
    void before.engine
      .request(request, {
        ownerId: "agent",
        requesterId: "agent",
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      .catch(() => undefined);
    await expect
      .poll(() => before.registry.leaseRequests().find((record) => record.requesterId === "agent"))
      .toMatchObject({ state: "open" });

    const after = await createHarness({ state: before.state });
    await after.engine.convergeRunningCapacity();
    return after;
  }

  it.each([{ idempotencyKey: "key-1" as string | undefined }, { idempotencyKey: undefined }])(
    "settles a request still open at a restart as failed and says the daemon restarted, whether it carried an idempotency key or not ($idempotencyKey)",
    async ({ idempotencyKey }) => {
      const after = await restartWithAgentQueued(idempotencyKey);

      expect(
        after.registry.leaseRequests().find((record) => record.requesterId === "agent"),
      ).toMatchObject({
        failure: { code: "INTERNAL", message: expect.stringContaining("daemon restarted") },
        state: "failed",
      });
      expect(
        after.bus
          .replay()
          .filter((event) => event.event === "lease.rejected")
          .map((event) => event.payload),
      ).toEqual([
        {
          reason: "daemon-restarted",
          requestId: expect.stringMatching(/^req_/),
          requester: "agent",
          requestSpec: request,
        },
      ]);
      if (idempotencyKey !== undefined) {
        await expect(
          after.engine.request(request, {
            idempotencyKey,
            ownerId: "agent",
            requesterId: "agent",
          }),
        ).rejects.toMatchObject({ message: expect.stringContaining("daemon restarted") });
      }
    },
  );
});

describe("createLeasing a grant and its request's result", () => {
  const asker = { idempotencyKey: "key-1", ownerId: "agent", requesterId: "agent" };

  it("answers a repeat under the same key with the lease after the daemon stopped between the grant and the request book's settle write", async () => {
    const before = await createHarness();
    await seedReady(before);
    vi.spyOn(before.registry, "settleLeaseRequest").mockRejectedValue(new Error("disk gone"));
    const grant = await before.engine.request(request, asker);
    await flush();

    const after = await createHarness({ driver: before.driver, state: before.state });
    await after.engine.convergeRunningCapacity();
    const repeat = await after.engine.request(request, asker);

    expect(repeat).toEqual(grant);
    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(after.registry.leaseRequests()).toMatchObject([{ state: "granted" }]);
    expect(after.registry.snapshot.leases).toHaveLength(1);
  });

  it("answers a repeat under the same key in the same process with the lease", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    const grant = await harness.engine.request(request, asker);
    await flush();

    const repeat = await harness.engine.request(request, asker);
    expect(repeat).toEqual(grant);
    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(harness.registry.leaseRequests()).toMatchObject([{ grant, state: "granted" }]);
  });

  it("answers a repeat of a granted request whose lease was released since with the lease as recorded and the device as it is now, and a renew of that lease with UnknownLeaseError", async () => {
    const harness = await createHarness();
    await seedReady(harness);
    const grant = await harness.engine.request(request, asker);
    await flush();
    await harness.engine.release(grant.lease.id, "explicit");
    await harness.engine.settle();

    const repeat = await harness.engine.request(request, asker);

    expect(repeat.lease.id).toBe(grant.lease.id);
    expect(grant.device.state).toBe("leased");
    expect(repeat).toEqual({ ...grant, device: harness.registry.snapshot.devices[0] });
    expect(repeat.device.state).toBe("deleted");
    await expect(harness.engine.renew(grant.lease.id)).rejects.toBeInstanceOf(UnknownLeaseError);
  });
});

describe("createLeasing class requests", () => {
  it("creates the first model on the class's preference list the catalog lists, for a request naming a class", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 15", "iPhone 16"],
      modelClasses: { "iPhone 15": "phone", "iPhone 16": "phone" },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 16", "iPhone 15"] } },
    });

    const granted = await harness.engine.request(
      { class: "phone", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.spec.model).toBe("iPhone 16");
  });

  it("creates the first listed model that pairs with the requested OS version, not one that pairs with another", async () => {
    const driver = new FakeDriver({
      availableOsVersions: ["18.4", "26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 16", "iPhone 17"],
      modelClasses: { "iPhone 16": "phone", "iPhone 17": "phone" },
      modelRuntimes: { "iPhone 16": ["18.4", "26.5"], "iPhone 17": ["26.5"] },
      platform: "ios",
    });
    const harness = await createHarness({
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17", "iPhone 16"] } },
    });

    const granted = await harness.engine.request(
      { class: "phone", osVersion: "18.4", platform: "ios" },
      { ownerId: "agent", requesterId: "agent" },
    );

    expect(granted.device.spec).toMatchObject({ model: "iPhone 16", osVersion: "18.4" });
  });

  it("refuses a class request naming an OS that is not installed as RUNTIME_MISSING without calling the installer", async () => {
    const asked: unknown[] = [];
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      knownModels: ["iPhone 17"],
      modelClasses: { "iPhone 17": "phone" },
      platform: "ios",
    });
    const harness = await createHarness({
      components: {
        claimProvision: () => () => undefined,
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "18.4" };
        },
      },
      driver,
      modelPreferences: { ios: { phone: ["iPhone 17"] } },
    });

    await expect(
      harness.engine.request(
        { class: "phone", osVersion: "18.4", platform: "ios" },
        { allowDownload: true, ownerId: "agent", requesterId: "agent" },
      ),
    ).rejects.toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
    expect(asked).toEqual([]);
  });
});
