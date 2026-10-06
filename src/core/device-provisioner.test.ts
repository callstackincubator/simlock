import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { sourceFilesRecursive, srcDir, stripComments } from "../test-support/imports.js";
import { type CapacityReservation } from "./capacity/index.js";
import { ComponentBeingRemovedError, ComponentInstaller } from "./component-installer.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DeviceProvisioner } from "./device-provisioner.js";
import { DriverCatalog } from "./driver-catalog.js";
import { DriverCrashError, BootTimeoutError, DiskSpaceGuard } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { ManagedDeviceLifecycle } from "./managed-device-lifecycle.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const statePath = "/home/agent/.simlock/state.json";
const spec = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

function reservation(): CapacityReservation & { readonly releaseCount: () => number } {
  let releases = 0;
  return { release: () => void releases++, releaseCount: () => releases };
}

async function createHarness(
  latencyMs?: {
    readonly makeReady?: number;
    readonly provision?: number;
  },
  logger?: Logger,
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const driver = new FakeDriver({
    clock,
    estimateMs: { boot: 20, provision: 30 },
    platform: "ios",
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
  let nextId = 0;
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const decisions = new SerializedDecision();
  const claims = new DeviceOperationClaims();
  const lifecycle = new ManagedDeviceLifecycle(
    new DriverCatalog([driver]),
    registry,
    decisions,
    claims,
    clock,
  );
  const components = new ComponentInstaller({
    clock,
    decisions,
    diskSpace: new DiskSpaceGuard(),
    drivers: new DriverCatalog([driver]),
    eventBus,
    filesystem: new MemoryFilesystem(),
    registry,
    timeoutMs: 1_200_000,
  });
  const provisioner = new DeviceProvisioner({
    catalog: new DriverCatalog([driver]),
    claims,
    clock,
    components,
    decisions,
    lifecycle,
    ...(logger === undefined ? {} : { logger }),
    registry,
  });
  return {
    claims,
    clock,
    components,
    decisions,
    driver,
    eventBus,
    lifecycle,
    provisioner,
    registry,
  };
}

describe("DeviceProvisioner", () => {
  it("records provision and boot durations from the injected clock", async () => {
    const harness = await createHarness({ makeReady: 7, provision: 11 });
    const pending = harness.provisioner.provision(spec, { reservation: reservation() });

    // The provision is claimed in the decision gate first; the driver's call starts after that.
    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1),
    );
    harness.clock.advance(11);
    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
    );
    harness.clock.advance(7);
    await pending;

    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.provisioned",
        payload: expect.objectContaining({ duration: 11 }),
      }),
    );
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.ready",
        payload: expect.objectContaining({ bootDuration: 7 }),
      }),
    );
  });

  it("provisions, registers, and readies a device with progress estimates and post-commit facts", async () => {
    const harness = await createHarness();
    const progress: string[] = [];
    const reserved = reservation();
    let readyStateAtEvent = "unknown";
    harness.eventBus.subscribe("device.ready", () => {
      readyStateAtEvent = harness.registry.snapshot.devices[0]?.state ?? "missing";
    });

    const ready = await harness.provisioner.provision(spec, {
      onProgress: (update) => progress.push(`${update.stage}:${update.etaMs}`),
      reservation: reserved,
    });

    expect(ready.device).toMatchObject({ state: "ready" });
    expect(progress).toEqual(["provisioning:30", "booting:20"]);
    expect(readyStateAtEvent).toBe("ready");
    expect(reserved.releaseCount()).toBe(1);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.provisioned",
        payload: expect.objectContaining({ duration: 0 }),
      }),
    );
  });

  it("retains exclusive ownership after ready until the lease handoff releases it", async () => {
    const harness = await createHarness();
    const handoff = await harness.provisioner.provision(spec, { reservation: reservation() });

    await expect(
      harness.lifecycle.shutdown(handoff.device, "test", "cleanup"),
    ).resolves.toBeUndefined();

    handoff.claim.release();
    await expect(
      harness.lifecycle.shutdown(handoff.device, "test", "cleanup"),
    ).resolves.toMatchObject({ state: "shutdown" });
  });

  it("holds the boot claim it was given, with its owner, on the new device while it boots, until the handoff is released", async () => {
    const harness = await createHarness({ makeReady: 5 });
    const pending = harness.provisioner.provision(spec, {
      claim: { kind: "boot", owner: "waiter-1" },
      reservation: reservation(),
    });

    await vi.waitFor(() =>
      expect(harness.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1),
    );
    const [registered] = harness.registry.snapshot.devices;
    expect(registered).toMatchObject({ state: "provisioning" });
    expect(harness.claims.claim(registered?.id ?? "")).toEqual({ kind: "boot", owner: "waiter-1" });

    harness.clock.advance(5);
    const handoff = await pending;
    expect(harness.claims.claim(handoff.device.id)).toEqual({ kind: "boot", owner: "waiter-1" });
    handoff.claim.release();
    expect(harness.claims.claim(handoff.device.id)).toBeUndefined();
  });

  it("holds an unowned boot claim when the one it was given names no owner", async () => {
    const harness = await createHarness();

    const handoff = await harness.provisioner.provision(spec, {
      claim: { kind: "boot" },
      reservation: reservation(),
    });

    expect(harness.claims.claim(handoff.device.id)).toEqual({ kind: "boot" });
  });

  it("leaves no claim behind when the device it claimed fails to become ready", async () => {
    const harness = await createHarness();
    harness.driver.failOn("makeReady", 1, new DriverCrashError("boot failed"));

    await expect(
      harness.provisioner.provision(spec, {
        claim: { kind: "boot", owner: "waiter-1" },
        reservation: reservation(),
      }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    const [failed] = harness.registry.snapshot.devices;
    expect(failed).toMatchObject({ state: "deleted" });
    expect(harness.claims.isClaimed(failed?.id ?? "")).toBe(false);
  });

  it("rolls back a registered device and returns BootTimeoutError-compatible failure on boot failure", async () => {
    const harness = await createHarness();
    const reserved = reservation();
    harness.driver.failOn("makeReady", 1, new DriverCrashError("boot failed"));

    await expect(
      harness.provisioner.provision(spec, { reservation: reserved }),
    ).rejects.toBeInstanceOf(BootTimeoutError);
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({ event: "device.deleted" }),
    );
    expect(reserved.releaseCount()).toBe(1);
  });

  it("A new device that fails to become ready logs the driver's error with the device id.", async () => {
    const sink = new MemoryLogSink();
    const harness = await createHarness(
      undefined,
      new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
    );
    harness.driver.failOn("makeReady", 1, new DriverCrashError("simulator never booted"));

    await expect(
      harness.provisioner.provision(spec, { reservation: reservation() }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    const deviceId = harness.registry.snapshot.devices[0]?.id;
    expect(deviceId).toBeDefined();
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.device-provisioner",
        fields: {
          deviceId,
          error: "DriverCrashError: simulator never booted",
          step: "boot",
        },
      }),
    ]);
  });

  it("A failed destroy after a failed boot logs the device id and the error.", async () => {
    const sink = new MemoryLogSink();
    const harness = await createHarness(
      undefined,
      new JsonLinesLogger({ clock: new FakeClock(1_000), sink }),
    );
    harness.driver.failOn("makeReady", 1, new DriverCrashError("simulator never booted"));
    harness.driver.failOn("destroy", 1, new DriverCrashError("simctl delete refused"));

    await expect(
      harness.provisioner.provision(spec, { reservation: reservation() }),
    ).rejects.toBeInstanceOf(BootTimeoutError);

    const deviceId = harness.registry.snapshot.devices[0]?.id;
    expect(deviceId).toBeDefined();
    expect(harness.registry.snapshot.devices[0]?.state).not.toBe("deleted");
    expect(sink.records.filter((record) => record.fields?.["step"] === "destroy")).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          deviceId,
          error: "DriverCrashError: simctl delete refused",
          step: "destroy",
        },
      }),
    ]);
  });

  it("destroys a device whose boot failed under a cleanup claim, not a boot claim a request could wait for.", async () => {
    const harness = await createHarness();
    harness.driver.failOn("makeReady", 1, new DriverCrashError("simulator never booted"));
    let finishDestroy: () => void = () => undefined;
    const realDestroy = harness.driver.destroy.bind(harness.driver);
    vi.spyOn(harness.driver, "destroy").mockImplementation(
      (device) =>
        new Promise<void>((resolve) => {
          finishDestroy = () => void realDestroy(device).then(resolve);
        }),
    );

    const failed = harness.provisioner.provision(spec, {
      claim: { kind: "boot" },
      reservation: reservation(),
    });
    const outcome = failed.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.driver.destroy).toHaveBeenCalledTimes(1));
    const deviceId = harness.registry.snapshot.devices[0]?.id ?? "";

    expect(harness.claims.claim(deviceId)).toEqual({ kind: "cleanup" });

    finishDestroy();
    await expect(outcome).resolves.toBeInstanceOf(BootTimeoutError);
  });

  it("releases its capacity reservation when the driver cannot provision", async () => {
    const harness = await createHarness();
    const reserved = reservation();
    harness.driver.failOn("provision", 1, new DriverCrashError("driver unavailable"));

    await expect(harness.provisioner.provision(spec, { reservation: reserved })).rejects.toThrow(
      "driver unavailable",
    );
    expect(harness.registry.snapshot.devices).toEqual([]);
    expect(reserved.releaseCount()).toBe(1);
  });

  it("releases capacity without destroying an unregistered device when registration fails", async () => {
    const harness = await createHarness();
    const reserved = reservation();
    const registrationError = new Error("state persistence failed");
    const provisioner = new DeviceProvisioner({
      catalog: new DriverCatalog([harness.driver]),
      claims: harness.claims,
      clock: harness.clock,
      components: harness.components,
      decisions: new SerializedDecision(),
      lifecycle: harness.lifecycle,
      registry: {
        async registerDevice() {
          throw registrationError;
        },
      },
    });

    await expect(provisioner.provision(spec, { reservation: reserved })).rejects.toBe(
      registrationError,
    );
    expect(reserved.releaseCount()).toBe(1);
    expect(harness.driver.calls.filter((call) => call.operation === "destroy")).toEqual([]);
  });
});

describe("DeviceProvisioner and a component removal (ADR 0010 §8)", () => {
  const removal = { platform: "ios" as const, requesterId: "tok_admin", version: "26.5" };

  /** A harness whose 26.5 runtime was installed by Simlock, so it can be removed. */
  async function withSimlockRuntime(latencyMs?: { readonly provision?: number }) {
    const harness = await createHarness(latencyMs);
    await harness.components.install({ component: "26.5", platform: "ios" });
    return harness;
  }

  function driverCalls(harness: { readonly driver: FakeDriver }, operation: string): number {
    return harness.driver.calls.filter((call) => call.operation === operation).length;
  }

  it("refuses a device on a version being removed before the driver creates it, registers nothing and releases the reservation", async () => {
    const harness = await withSimlockRuntime();
    harness.driver.holdRemovals();
    const removing = harness.components.remove(removal);
    await vi.waitFor(() => expect(driverCalls(harness, "removeComponent")).toBe(1));
    const reserved = reservation();

    await expect(harness.provisioner.provision(spec, { reservation: reserved })).rejects.toThrow(
      ComponentBeingRemovedError,
    );

    expect(driverCalls(harness, "provision")).toBe(0);
    expect(harness.registry.snapshot.devices).toEqual([]);
    expect(reserved.releaseCount()).toBe(1);
    harness.driver.releaseRemovals();
    await expect(removing).resolves.toMatchObject({ outcome: "removed" });
  });

  it("counts a device the driver is still creating as in use, so a removal started meanwhile is refused", async () => {
    const harness = await withSimlockRuntime({ provision: 50 });
    const provisioning = harness.provisioner.provision(spec, { reservation: reservation() });
    await vi.waitFor(() => expect(driverCalls(harness, "provision")).toBe(1));
    expect(harness.registry.snapshot.devices).toEqual([]);

    await expect(harness.components.remove(removal)).rejects.toMatchObject({
      devices: 1,
      foreignDevices: 0,
      name: "ComponentInUseError",
    });
    expect(driverCalls(harness, "removeComponent")).toBe(0);

    harness.clock.advance(50);
    await provisioning;
    // Once registered the device is counted by the registry alone, not twice.
    const listed = await harness.components.list("ios");
    expect(listed.find((component) => component.version === "26.5")).toMatchObject({
      devices: 1,
    });
  });

  describe("for a spec with an image tag, which is still a device of its platform and version", () => {
    const tagged = { ...spec, imageTag: "google_apis_playstore" };

    it("refuses it while that version is being removed", async () => {
      const harness = await withSimlockRuntime();
      harness.driver.holdRemovals();
      const removing = harness.components.remove(removal);
      await vi.waitFor(() => expect(driverCalls(harness, "removeComponent")).toBe(1));

      await expect(
        harness.provisioner.provision(tagged, { reservation: reservation() }),
      ).rejects.toThrow(ComponentBeingRemovedError);

      expect(driverCalls(harness, "provision")).toBe(0);
      harness.driver.releaseRemovals();
      await expect(removing).resolves.toMatchObject({ outcome: "removed" });
    });

    it("counts it as in use while it is created and once it is registered", async () => {
      const harness = await withSimlockRuntime({ provision: 50 });
      const provisioning = harness.provisioner.provision(tagged, { reservation: reservation() });
      await vi.waitFor(() => expect(driverCalls(harness, "provision")).toBe(1));

      await expect(harness.components.remove(removal)).rejects.toMatchObject({
        devices: 1,
        name: "ComponentInUseError",
      });

      harness.clock.advance(50);
      await provisioning;
      expect(harness.registry.snapshot.devices.map((device) => device.spec)).toEqual([tagged]);
      const listed = await harness.components.list("ios");
      expect(listed.find((component) => component.version === "26.5")).toMatchObject({
        devices: 1,
      });
      await expect(harness.components.remove(removal)).rejects.toMatchObject({
        devices: 1,
        name: "ComponentInUseError",
      });
    });
  });

  it("is the only code in src that asks a driver to provision or registers a device", () => {
    const sources = sourceFilesRecursive(srcDir);
    // Every production source file is read, not a chosen few (testing rule 4).
    expect(sources.length).toBeGreaterThan(100);

    // Call sites per file, comments stripped, whatever the receiver is called: a driver reached as
    // `catalog.get(platform).provision(...)` is as much a second creator as `driver.provision(...)`.
    const callSites = (pattern: RegExp) =>
      Object.fromEntries(
        sources
          .map((file) => [
            relative(srcDir, file),
            stripComments(readFileSync(file, "utf8")).match(pattern)?.length ?? 0,
          ])
          .filter(([, count]) => count !== 0),
      );

    expect(callSites(/\.registerDevice\(/g)).toEqual({
      [join("core", "device-provisioner.ts")]: 1,
    });
    expect(callSites(/\.provision\(/g)).toEqual({
      // The driver call itself.
      [join("core", "device-provisioner.ts")]: 1,
      // `provisioner.provision(...)`: the lease path asking this module, not a driver.
      [join("core", "lease-acquisition-coordinator.ts")]: 1,
    });
  });

  it("takes its claim inside the decision gate, so the driver creates nothing while another decision holds it", async () => {
    const harness = await withSimlockRuntime();
    let releaseGate!: () => void;
    void harness.decisions.run(
      () =>
        new Promise<void>((resolve) => {
          releaseGate = resolve;
        }),
    );

    const provisioning = harness.provisioner.provision(spec, { reservation: reservation() });
    for (let count = 0; count < 100; count += 1) await Promise.resolve();

    expect(driverCalls(harness, "provision")).toBe(0);
    const listed = await harness.components.list("ios");
    expect(listed.find((component) => component.version === "26.5")).toMatchObject({
      devices: 0,
    });
    releaseGate();
    await provisioning;
    expect(driverCalls(harness, "provision")).toBe(1);
  });

  it("ends its claim when the driver cannot provision, so the component can be removed", async () => {
    const harness = await withSimlockRuntime();
    harness.driver.failOn("provision", 1, new DriverCrashError("simctl create failed"));

    await expect(
      harness.provisioner.provision(spec, { reservation: reservation() }),
    ).rejects.toThrow("simctl create failed");

    await expect(harness.components.remove(removal)).resolves.toMatchObject({
      outcome: "removed",
    });
  });
});
