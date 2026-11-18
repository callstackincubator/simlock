import { describe, expect, it } from "vitest";
import { type StateDatabase } from "../state/index.js";
import { Registry } from "./index.js";
import { physicalInput, seededWorld } from "./test-registry.js";

describe("Registry: quarantineCause", () => {
  const purgeCause = {
    kind: "purge-failed" as const,
    message: "DriverCrashError: simctl erase exited 164",
  };

  async function reclaimingVirtual() {
    const world = await seededWorld();
    await world.register("virtual");
    await world.lease("dev_virtual", "lse_virtual");
    await world.registry.beginRelease("lse_virtual");
    return world;
  }

  async function quarantinedVirtual() {
    const world = await reclaimingVirtual();
    await world.registry.enterQuarantine("dev_virtual", 5_000, purgeCause);
    return world;
  }

  async function quarantinedPhysical() {
    const world = await seededWorld();
    await world.enroll("physical");
    await world.lease("dev_physical", "lse_physical");
    await world.registry.beginRelease("lse_physical");
    await world.registry.enterQuarantine("dev_physical", 5_000, purgeCause);
    return world;
  }

  const storedCauseKinds = (world: { state: StateDatabase }) =>
    world.state.database.prepare("SELECT quarantine_cause_kind FROM devices").all();

  it("a quarantined record with each kind, written by enterQuarantine and loaded by a new Registry, has its cause", async () => {
    const causes = [
      { kind: "purge-failed", message: "Error: purge exploded" },
      { kind: "shutdown-failed", message: "Error: shutdown exploded" },
      { kind: "delete-failed", message: "Error: delete exploded" },
      { kind: "stalled", stalledState: "provisioning" },
      { kind: "stalled", stalledState: "reclaiming" },
    ] as const;

    for (const cause of causes) {
      const { registry, reload } = await reclaimingVirtual();
      if (cause.kind === "delete-failed") {
        await registry.completeReclaimWithoutPurge("dev_virtual");
      }
      const entered = await registry.enterQuarantine("dev_virtual", 5_000, cause);
      expect(entered.quarantineCause, cause.kind).toEqual(cause);

      const reloaded = await reload();
      expect(reloaded.snapshot.devices[0], cause.kind).toMatchObject({
        quarantineCause: cause,
        state: "quarantined",
      });
    }
  });

  describe("every exit from quarantined removes it", () => {
    const readyEvent = (id: string) => ({
      event: "device.ready" as const,
      payload: { bootDuration: 0, deviceId: id },
    });
    const exits: readonly (readonly [string, (registry: Registry) => Promise<unknown>])[] = [
      ["recoverFromQuarantine to ready", (r) => r.recoverFromQuarantine("dev_virtual", "ready")],
      [
        "recoverFromQuarantine to shutdown",
        (r) => r.recoverFromQuarantine("dev_virtual", "shutdown"),
      ],
      ["deleteQuarantined", (r) => r.deleteQuarantined("dev_virtual", "lease-end")],
      ["markDeviceMissing", (r) => r.markDeviceMissing("dev_virtual", "doctor")],
      [
        "transitionDevice to ready",
        (r) => r.transitionDevice("dev_virtual", "ready", readyEvent("dev_virtual")),
      ],
      [
        "transitionDevice to shutdown",
        (r) =>
          r.transitionDevice("dev_virtual", "shutdown", {
            event: "device.shutdown",
            payload: { deviceId: "dev_virtual", initiator: "idle" },
          }),
      ],
      [
        "transitionDevice to deleted",
        (r) =>
          r.transitionDevice("dev_virtual", "deleted", {
            event: "device.deleted",
            payload: { deviceId: "dev_virtual", initiator: "lease-end" },
          }),
      ],
    ];

    it.each(exits)("%s", async (_name, exit) => {
      const world = await quarantinedVirtual();
      const { registry } = world;
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect(storedCauseKinds(world)).toEqual([{ quarantine_cause_kind: null }]);
    });

    it.each([
      [
        "reenrollPhysical",
        (r: Registry) =>
          r.reenrollPhysical("dev_physical", { ...physicalInput, apps: ["com.example.one"] }),
      ],
      ["unenrollPhysical", (r: Registry) => r.unenrollPhysical("dev_physical")],
    ])("%s", async (_name, exit) => {
      const world = await quarantinedPhysical();
      const { registry } = world;
      expect(registry.snapshot.devices[0]).toHaveProperty("quarantineCause");

      const result = await exit(registry);

      expect(result).not.toHaveProperty("quarantineCause");
      expect(registry.snapshot.devices[0]).not.toHaveProperty("quarantineCause");
      expect(storedCauseKinds(world)).toEqual([{ quarantine_cause_kind: null }]);
    });
  });
});
