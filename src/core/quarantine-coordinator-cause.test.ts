import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { VirtualSpec } from "./domain.js";
import { FakeDriver, loadTestRegistry, openTestState } from "./testing.js";
import { QuarantineCoordinator } from "./quarantine-coordinator.js";
import { SerializedDecision } from "./serialized-decision.js";
import { spec, retryConfig, flush } from "./test-quarantine-coordinator.js";

// why: index.ts does not export the coordinator, so its retry timers, claims and give-up order are an ordering the surface cannot force.
describe("QuarantineCoordinator quarantine cause", () => {
  const androidSpec: VirtualSpec = {
    physical: false,
    model: "Pixel 8",
    osVersion: "35",
    platform: "android",
  };
  const PHYSICAL_ID = "00008110-001A2B3C4D5E";

  type StartState = "provisioning" | "reclaiming" | "shutdown";

  async function build(
    options: {
      readonly physical?: boolean;
      readonly platform?: "ios" | "android";
      readonly state?: StartState;
      readonly fresh?: boolean;
    } = {},
  ) {
    const platform = options.platform ?? "ios";
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform });
    const state = options.state ?? "reclaiming";
    const testState = await openTestState();
    const seeding = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => (options.physical === true ? "physical" : "virtual") },
      state: testState,
    });
    let id: string;
    if (options.physical === true) {
      driver.setPhysicalPresence(PHYSICAL_ID, true);
      id = "dev_physical";
      await seeding.enrollPhysical({
        apps: [],
        class: "phone",
        driverDeviceId: PHYSICAL_ID,
        model: "iPhone 15 Pro",
        osVersion: "18.4",
        platform: "ios",
      });
      testState.database
        .prepare(
          "UPDATE devices SET created_at = 600, last_lease_ended_at = 700, ready_at = NULL, state = ?",
        )
        .run(state);
    } else {
      const virtualSpec = platform === "android" ? androidSpec : spec;
      const provisioned = await driver.provision(virtualSpec);
      id = "dev_virtual";
      await seeding.registerDevice({
        driverData: provisioned.driverData,
        driverDeviceId: provisioned.deviceId,
        provisionDuration: 0,
        spec: virtualSpec,
      });
      testState.database.prepare("UPDATE devices SET created_at = 1, state = ?").run(state);
      if (options.fresh === true) {
        testState.database
          .prepare("UPDATE devices SET last_lease_ended_at = 900, lease_identity = 'fresh'")
          .run();
      }
    }
    const registry = await loadTestRegistry({
      clock,
      eventBus: bus,
      idGenerator: { generate: () => "id" },
      state: testState,
    });
    const claims = new DeviceOperationClaims();
    const coordinator = new QuarantineCoordinator({
      claims,
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability: vi.fn(),
      registry,
    });
    const device = () => registry.snapshot.devices.find((candidate) => candidate.id === id);
    const quarantinedPayload = () =>
      bus.replay().find((event) => event.event === "device.quarantined")?.payload;
    return { bus, claims, clock, coordinator, device, driver, id, quarantinedPayload, registry };
  }

  function failure(
    id: string,
    kind: "purge-failed" | "shutdown-failed" | "delete-failed",
    error: string,
  ) {
    return {
      attemptedStrategy: kind === "purge-failed" ? ("wipe" as const) : ("delete" as const),
      deviceId: id,
      duration: 5,
      error,
      kind,
      leaseId: "lease-1",
    };
  }

  it.each(["ios", "android"] as const)(
    "device.quarantine-abandoned and device.quarantine-stranded carry the device's own platform, for an %s device",
    async (platform) => {
      const abandoned = await build({ platform });
      abandoned.driver.failOn("destroy", 1, new Error("still stuck"));
      abandoned.driver.failOn("destroy", 2, new Error("still stuck"));
      await abandoned.coordinator.enter(failure(abandoned.id, "purge-failed", "boom"));
      abandoned.clock.advance(retryConfig.retryBackoffMs);
      await flush();
      abandoned.clock.advance(2_000);
      await flush();

      const stranded = await build({ platform });
      stranded.driver.failOn("destroy", 1, new Error("still stuck"));
      stranded.driver.failOn("destroy", 2, new Error("still stuck"));
      stranded.driver.failOn("destroy", 3, new Error("destroy blew up"));
      await stranded.coordinator.enter(failure(stranded.id, "purge-failed", "boom"));
      stranded.clock.advance(retryConfig.retryBackoffMs);
      await flush();
      stranded.clock.advance(2_000);
      await flush();

      const payloadOf = (harness: { readonly bus: EventBus }, name: string) =>
        harness.bus.replay().find((event) => event.event === name)?.payload;
      expect([
        payloadOf(abandoned, "device.quarantine-abandoned"),
        payloadOf(stranded, "device.quarantine-stranded"),
      ]).toMatchObject([{ platform }, { platform }]);
    },
  );

  it.each([
    ["purge-failed", "reclaiming"],
    ["shutdown-failed", "reclaiming"],
    ["delete-failed", "shutdown"],
  ] as const)(
    "enter writes quarantineCause kind %s and its message on the record and on device.quarantined",
    async (kind, state) => {
      const harness = await build({ fresh: kind !== "purge-failed", state });

      await harness.coordinator.enter(failure(harness.id, kind, "DriverCrashError: it broke"));

      expect(harness.device()).toMatchObject({ state: "quarantined" });
      expect(harness.device()?.quarantineCause).toEqual({
        kind,
        message: "DriverCrashError: it broke",
      });
      expect(harness.quarantinedPayload()).toMatchObject({
        kind,
        message: "DriverCrashError: it broke",
      });
      expect(harness.quarantinedPayload()).not.toHaveProperty("stalledState");
    },
  );

  it("cleans the message: control characters become spaces, it is trimmed, cut at 300 with a final ellipsis, and left out when empty; device.purge-failed keeps the full text", async () => {
    const long = (length: number) => `Error: ${"x".repeat(length - 7)}`;
    const cases: readonly (readonly [string, string, string | undefined])[] = [
      ["control characters", "\n Error: a\r\nb\u0000c d \t", "Error: a  b c d"],
      ["300 characters", long(300), long(300)],
      ["301 characters", long(301), `${long(301).slice(0, 299)}…`],
      ["a high surrogate at 299", `${"x".repeat(298)}😀yyy`, `${"x".repeat(298)}…`],
      ["only whitespace and controls", " \n\t\u0007 ", undefined],
    ];

    for (const [name, error, expected] of cases) {
      const harness = await build();

      await harness.coordinator.enter(failure(harness.id, "purge-failed", error));

      const cause = harness.device()?.quarantineCause;
      expect(cause, name).toBeDefined();
      expect(cause?.message, name).toBe(expected);
      if (expected === undefined) expect(cause, name).toEqual({ kind: "purge-failed" });
      else expect(expected.length, name).toBeLessThanOrEqual(300);
      expect(harness.quarantinedPayload(), name).toMatchObject({ kind: "purge-failed" });
      expect((harness.quarantinedPayload() as { message?: string }).message, name).toBe(expected);
      const purgeFailed = harness.bus
        .replay()
        .find((event) => event.event === "device.purge-failed");
      expect(purgeFailed?.payload, name).toMatchObject({ error });
    }
  });

  it.each([
    ["provisioning", false],
    ["reclaiming", false],
    ["reclaiming", true],
  ] as const)(
    "enterFromStalledTransition of a device stalled %s (physical %s) writes kind stalled with its stalledState and no message, on the record and on the event",
    async (stalledState, physical) => {
      const harness = await build({ physical, state: stalledState });

      await harness.coordinator.enterFromStalledTransition(harness.id, stalledState);

      expect(harness.device()?.state).toBe("quarantined");
      expect(harness.device()?.quarantineCause).toEqual({ kind: "stalled", stalledState });
      expect(harness.quarantinedPayload()).toMatchObject({ kind: "stalled", stalledState });
      expect(harness.quarantinedPayload()).not.toHaveProperty("message");
    },
  );

  it("enterFromStalledTransition of a device in another state, the lease engine's hand-over after a failed destroy, writes kind delete-failed", async () => {
    const harness = await build({ physical: false, state: "shutdown" });

    const entered = await harness.coordinator.enterFromStalledTransition(harness.id, "shutdown");

    expect(entered).toBe(true);
    expect(harness.device()?.state).toBe("quarantined");
    expect(harness.device()?.quarantineCause).toEqual({ kind: "delete-failed" });
    expect(harness.quarantinedPayload()).toMatchObject({ kind: "delete-failed" });
  });

  it.each(["ios", "android"] as const)(
    "device.quarantined carries the %s device's platform from enter and from enterFromStalledTransition",
    async (platform) => {
      const entered = await build({ platform });
      await entered.coordinator.enter(failure(entered.id, "purge-failed", "Error: boom"));
      const stalled = await build({ platform });
      await stalled.coordinator.enterFromStalledTransition(stalled.id, "reclaiming");

      expect(entered.quarantinedPayload()).toMatchObject({ platform });
      expect(stalled.quarantinedPayload()).toMatchObject({ platform });
    },
  );

  it("a stalled entry that writes nothing, because the device is claimed or has moved on, leaves no cause", async () => {
    const claimed = await build();
    const held = claimed.claims.tryClaim(claimed.id, "boot");
    await claimed.coordinator.enterFromStalledTransition(claimed.id, "reclaiming");
    held?.release();
    const moved = await build({ state: "provisioning" });
    await moved.coordinator.enterFromStalledTransition(moved.id, "reclaiming");

    for (const harness of [claimed, moved]) {
      expect(harness.device()?.state).not.toBe("quarantined");
      expect(harness.device()).not.toHaveProperty("quarantineCause");
      expect(harness.bus.replay()).toEqual([]);
    }
  });

  it("a failed delete retry keeps the cause written at entry", async () => {
    const harness = await build({ fresh: true, state: "shutdown" });
    harness.driver.failOn("destroy", 1, new Error("still stuck"));
    await harness.coordinator.enter(failure(harness.id, "delete-failed", "Error: first"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.device()).toMatchObject({ quarantineAttempts: 1, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "delete-failed",
      message: "Error: first",
    });
  });

  it("a physical retry that waits for the device to be present keeps the cause written at entry", async () => {
    const harness = await build({ physical: true });
    await harness.coordinator.enter(failure(harness.id, "purge-failed", "Error: first"));
    harness.driver.setPhysicalPresence(PHYSICAL_ID, false);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.device()).toMatchObject({ quarantineAttempts: 0, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "purge-failed",
      message: "Error: first",
    });
  });

  it("a stranded give-up keeps the cause written at entry", async () => {
    const harness = await build();
    harness.driver.failOn("destroy", 1, new Error("still stuck"));
    harness.driver.failOn("destroy", 2, new Error("still stuck"));
    harness.driver.failOn("destroy", 3, new Error("cannot destroy"));
    await harness.coordinator.enter(failure(harness.id, "purge-failed", "Error: first"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(harness.bus.replay().map((event) => event.event)).toContain(
      "device.quarantine-stranded",
    );
    expect(harness.device()).toMatchObject({ quarantineAttempts: 2, state: "quarantined" });
    expect(harness.device()?.quarantineCause).toEqual({
      kind: "purge-failed",
      message: "Error: first",
    });
  });
});
