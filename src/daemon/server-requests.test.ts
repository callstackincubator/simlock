import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { PassthroughRefusedError } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import {
  createClient,
  createHarness,
  hello,
  leaseIdOf,
  passthroughFake,
  stopTestDaemons,
  testServerConfig,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer", () => {
  it("answers status.get with the capacity, answers list.get, config.get, cleanup.run and events.replay as ok, pushes subscribed events, and renews and releases a lease", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        capacity: {
          // why: the harness has an iOS driver only, so the global limit is its one iOS slot (#1689).
          global: { maxRunning: 1, overLimit: false, reserved: 0, running: 0, warm: 0 },
          ios: {
            limit: 1,
            maxRunning: 1,
            overLimit: false,
            reserved: 0,
            running: 0,
            used: 0,
            warm: 0,
          },
        },
      },
    });
    await expect(client.request("list.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("config.get", {})).resolves.toMatchObject({ ok: true });
    await expect(client.request("cleanup.run", { dryRun: true })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.replay", { sinceTs: 0 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.request("events.subscribe", {})).resolves.toMatchObject({ ok: true });
    harness.eventBus.emit(
      "disk.pressure-detected",
      { freeBytes: 1, threshold: testServerConfig().diskPressure.freeBytesThreshold },
      "test",
    );
    await expect(client.nextFrame((frame) => frame.push === "event")).resolves.toMatchObject({
      push: "event",
    });
    await expect(client.request("events.unsubscribe", {})).resolves.toMatchObject({ ok: true });

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });
    const leaseId = (grant.payload as { readonly lease: { readonly id: string } }).lease.id;
    await expect(client.request("lease.renew", { leaseId, ttlMs: 120_000 })).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(client.request("lease.release", { leaseId })).resolves.toMatchObject({ ok: true });
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("routes usage.get to the dispatcher with the window the frame carries", async () => {
    const harness = await createHarness({ withHistory: true });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const answer = await client.request("usage.get", { from: 0, to: 3_600_000 });

    expect(answer).toMatchObject({
      ok: true,
      payload: { totals: { requests: 0 }, window: { from: 0, to: 3_600_000 } },
    });
  });

  it("serves the device catalog, omitting platforms with no registered driver", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(client.request("catalog.get", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        platforms: [{ defaultRuntime: "26.5", models: [], platform: "ios", runtimes: ["26.5"] }],
      },
    });
    await expect(client.request("catalog.get", { platform: "ios" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [{ platform: "ios" }] },
    });
    await expect(client.request("catalog.get", { platform: "android" })).resolves.toMatchObject({
      ok: true,
      payload: { platforms: [] },
    });
    await expect(client.request("catalog.get", { platform: "foo" })).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
      ok: false,
    });
  });

  it("resolves a passthrough to its driver's command without running it here", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughFake({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: (args) => ({
        args: ["simctl", "--set", "/root", ...args],
        command: "xcrun",
        env: {},
      }),
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["list", "devices"], tool: "simctl" }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { args: ["simctl", "--set", "/root", "list", "devices"], command: "xcrun" },
    });
  });

  it("gives a refused verb its own code, so the CLI can render it as a usage error", async () => {
    const clock = new FakeClock(1_000);
    const driver = passthroughFake({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: () => {
        throw new PassthroughRefusedError("simctl", "Refusing it; use `simlock release` instead.");
      },
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["delete", "ABCD"], tool: "simctl" }),
    ).resolves.toMatchObject({
      error: { code: "PASSTHROUGH_REFUSED", message: expect.stringContaining("simlock release") },
      ok: false,
    });
  });

  it.each([[{ args: "list", tool: "simctl" }], [{ args: ["list"] }]])(
    "rejects a malformed passthrough payload: %s",
    async (payload) => {
      const harness = await createHarness();
      const client = await createClient(harness.socketPath);
      await hello(client);

      await expect(client.request("driver.passthrough", payload)).resolves.toMatchObject({
        error: { code: "BAD_REQUEST" },
        ok: false,
      });
    },
  );

  it("distinguishes an unknown passthrough tool from a malformed payload", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);

    await expect(
      client.request("driver.passthrough", { args: ["devices"], tool: "adb" }),
    ).resolves.toMatchObject({
      error: { code: "UNKNOWN_PASSTHROUGH_TOOL" },
      ok: false,
    });
  });

  it("answers device.add and device.remove over the socket from the daemon's enrollment", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({
      clock,
      physicalDevices: [
        { apps: ["a"], ids: ["UDID-1"], model: "iPhone 15 Pro", osVersion: "18.4" },
      ],
      platform: "ios",
    });
    const harness = await createHarness({ clock, driver, includeEnrollment: true });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const added = await client.request("device.add", { id: "UDID-1", platform: "ios" }, "add-1");
    const removed = await client.request("device.remove", { id: "UDID-1" }, "remove-1");

    expect(added).toMatchObject({
      ok: true,
      payload: { appCount: 1, driverDeviceId: "UDID-1", platform: "ios", reenrolled: false },
    });
    expect(removed).toMatchObject({
      ok: true,
      payload: { driverDeviceId: "UDID-1", id: "dev_1" },
    });
  });
});

describe("DaemonServer decorations", () => {
  it("surfaces a derived transitionAgeMs for a mid-transition device in status and list --devices", async () => {
    const harness = await createHarness();
    const device = await harness.registry.registerDevice({
      driverData: { fakeDeviceId: "driver_provisioning" },
      driverDeviceId: "driver_provisioning",
      provisionDuration: 0,
      spec: { physical: false, model: "iPhone 16", osVersion: "26.5", platform: "ios" },
    });
    harness.clock.advance(5_000);

    const observer = await createClient(harness.socketPath);
    await hello(observer);
    await expect(observer.request("status.get", {})).resolves.toMatchObject({
      ok: true,
      payload: { devices: [{ id: device.id, transitionAgeMs: 5_000 }] },
    });
    await expect(observer.request("list.get", { kind: "devices" })).resolves.toMatchObject({
      ok: true,
      payload: [{ id: device.id, transitionAgeMs: 5_000 }],
    });
    await observer.close();
  });

  describe("operational logging", () => {
    it("drains the backgrounded reclaims before disposing, on a graceful stop", async () => {
      const order: string[] = [];
      let finishSettle!: () => void;
      const settling = new Promise<void>((resolve) => {
        finishSettle = resolve;
      });
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle-start");
          await settling;
          order.push("settle-end");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      const grant = await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await holder.request("lease.release", { leaseId: leaseIdOf(grant) });
      expect(harness.registry.snapshot.leases).toHaveLength(0);

      const stopping = harness.daemon.stop("test-drain");
      await expect.poll(() => order).toEqual(["settle-start"]);

      finishSettle();
      await stopping;
      // why: Disposal last: a reclaim that settles into a purge failure arms a quarantine
      // retry timer, and cancelling before the drain would strand it armed.
      expect(order).toEqual(["settle-start", "settle-end", "dispose"]);
    });

    it("starts the physical-device watcher with the daemon and disposes it on stop before draining settle", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        physicalDeviceWatcher: {
          dispose: () => {
            order.push("watcher-dispose");
          },
          start: () => {
            order.push("watcher-start");
          },
        },
        settle: async () => {
          order.push("settle");
        },
      });

      await harness.daemon.stop("test-watcher");

      expect(order).toEqual(["watcher-start", "watcher-dispose", "settle"]);
    });

    it("waits for an asynchronous disposal before reporting the daemon stopped", async () => {
      let disposed = false;
      let finishDispose!: () => void;
      const disposing = new Promise<void>((resolve) => {
        finishDispose = resolve;
      });
      const harness = await createHarness({
        dispose: async () => {
          await disposing;
          disposed = true;
        },
      });

      const stopping = harness.daemon.stop("test-async-dispose");
      await expect.poll(() => disposed).toBe(false);

      // why: A driver's release is asynchronous -- Android's reaps the adb server it started --
      // and a stop that returned before it finished would report a shutdown that had not
      // happened, leaving the next daemon to find the port still held.
      finishDispose();
      await stopping;
      expect(disposed).toBe(true);
    });

    it("stops an auxiliary frontend before releasing held leases and draining settle", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        dispose: () => {
          order.push("dispose");
        },
        settle: async () => {
          order.push("settle");
        },
        stopAuxiliary: async () => {
          order.push("stopAuxiliary");
        },
      });
      const holder = await createClient(harness.socketPath);
      await hello(holder);
      await holder.request("lease.request", {
        requesterId: "holder",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      await harness.daemon.stop("test-stop-auxiliary");

      expect(order).toEqual(["stopAuxiliary", "settle", "dispose"]);
      expect(harness.registry.snapshot.leases).toHaveLength(1);
    });

    it("calls beginStop once, before stopAuxiliary, when a stop is asked for", async () => {
      const order: string[] = [];
      const harness = await createHarness({
        beginStop: () => {
          order.push("beginStop");
        },
        stopAuxiliary: async () => {
          order.push("stopAuxiliary");
        },
      });

      await harness.daemon.stop("test-begin-stop");
      await harness.daemon.stop("again");

      expect(order).toEqual(["beginStop", "stopAuxiliary"]);
    });
  });
});
