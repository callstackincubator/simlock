import { describe, expect, it, vi } from "vitest";

import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: backend capabilities", () => {
  it("refuses baseline save on a backend without baselines while keeping the lease active", async () => {
    const { dispatcher, registry } = await buildDispatcher({
      driverOptions: { capabilities: { baselines: false, physical: true, except: true } },
    });
    const grant = await dispatcher.dispatch(
      "lease.request",
      {
        platform: "ios",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
      },
      session(),
    );

    const saving = dispatcher.dispatch(
      "baseline.save",
      {
        leaseId: grant.lease.id,
        name: "checkout",
      },
      session({ role: "admin" }),
    );

    await expect(saving).rejects.toMatchObject({ name: "BadDeviceRequestError" });
    expect(registry.snapshot.leases.map((lease) => lease.id)).toEqual([grant.lease.id]);
    const device = registry.snapshot.devices.find((current) => current.id === grant.device.id);
    expect(device?.state).toBe("leased");
  });
});

describe("Dispatcher: baseline.remove while a copy is reclaiming", () => {
  it("refuses the remove with DEVICE_BUSY naming the reclaiming device, and removes the baseline once its reclaim ends", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { shutdown: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const operator = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: operator.lease.id, name: "checkout" },
      admin,
    );
    const copy = await dispatcher.dispatch(
      "lease.request",
      { baseline: "checkout", platform: "ios" },
      session(),
    );
    const stateOf = (): string | undefined =>
      registry.snapshot.devices.find((device) => device.id === copy.device.id)?.state;
    await dispatcher.dispatch("lease.release", { leaseId: copy.lease.id }, session());
    await vi.waitFor(() => expect(stateOf()).toBe("reclaiming"));

    const refusal = await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(refusal).toMatchObject({
      code: "DEVICE_BUSY",
      details: { id: copy.device.id, reason: "reclaiming" },
    });
    await vi.waitFor(() => {
      clock.advance(1_000);
      expect(stateOf()).toBe("deleted");
    });
    expect(await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin)).toEqual({
      deletedDevices: [],
      name: "checkout",
      versions: [1],
    });
  });
});

describe("Dispatcher: baseline.remove while a copy is being made", () => {
  it("refuses the remove with DEVICE_BUSY and reason busy, naming the device, until the copy is leased", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({
      driverOptions: { latencyMs: { makeReady: 1_000 } },
    });
    const admin = session({ role: "admin" });
    const finish = async <Result>(pending: Promise<Result>): Promise<Result> => {
      let done = false;
      void pending.then(
        () => (done = true),
        () => (done = true),
      );
      await vi.waitFor(() => {
        clock.advance(1_000);
        expect(done).toBe(true);
      });
      return pending;
    };
    const operator = await finish(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      ),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: operator.lease.id, name: "checkout" },
      admin,
    );
    const copyRequest = dispatcher.dispatch(
      "lease.request",
      { baseline: "checkout", platform: "ios" },
      session(),
    );
    await vi.waitFor(() =>
      expect(
        registry.snapshot.virtualDevices.some(
          (device) => device.spec.baseline?.name === "checkout" && device.state !== "deleted",
        ),
      ).toBe(true),
    );
    const making = registry.snapshot.virtualDevices.find(
      (device) => device.spec.baseline?.name === "checkout" && device.state !== "deleted",
    );

    const refusal = await dispatcher.dispatch("baseline.remove", { name: "checkout" }, admin).then(
      () => undefined,
      (rejected: unknown) => rejected,
    );

    expect(refusal).toMatchObject({
      code: "DEVICE_BUSY",
      details: { id: making?.id, reason: "busy" },
    });
    await finish(copyRequest);
  });
});
