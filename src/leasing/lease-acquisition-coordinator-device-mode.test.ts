import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { type DeviceMode, type VirtualSpec, specMode } from "../core/index.js";
import { FakeDriver } from "../core/testing.js";
import { request, createHarness, seedReady } from "./test-lease-acquisition.js";

describe("LeaseAcquisitionCoordinator", () => {
  describe("device mode", () => {
    /** A driver that slims 26.5 and cannot slim 17.5, like iOS on either side of 18.5. */
    function slimmingDriver(options: { readonly mode?: DeviceMode } = {}): FakeDriver {
      return new FakeDriver({
        availableOsVersions: ["17.5", "26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
        slimmableOsVersions: ["26.5"],
        ...options,
      });
    }

    const owner = (id: string) => ({ ownerId: id, requesterId: id });

    it.each([
      ["full", "no mode", undefined, "full"],
      ["slim", "no mode", undefined, "slim"],
      ["full", "mode slim", "slim", "slim"],
      ["slim", "mode full", "full", "full"],
    ] as const)(
      "on a worker whose default is %s, a request with %s gets that device mode",
      async (defaultMode, _label, mode, planned) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });

        const granted = await harness.coordinator.request(
          { ...request, ...(mode === undefined ? {} : { mode }) },
          owner("agent"),
        );

        expect(specMode(granted.device.spec)).toBe(planned);
        expect(granted.device.mode).toBe(planned);
      },
    );

    it.each([
      ["slim", "slim", true],
      ["slim", "full", false],
      ["full", "full", true],
      ["full", "slim", false],
    ] as const)(
      "on a worker whose default is %s, a device whose pool mode is %s reports servesDefaultMode %s",
      async (defaultMode, poolMode, served) => {
        const harness = await createHarness({
          defaultModes: { ios: defaultMode },
          drivers: [slimmingDriver()],
        });
        const spec = {
          physical: false as const,
          model: "iPhone 17",
          osVersion: "26.5",
          platform: "ios" as const,
          ...(poolMode === "slim" ? { mode: "slim" as const } : {}),
        };

        expect(harness.coordinator.servesDefaultMode(spec)).toBe(served);
      },
    );

    it("compares a device's pool mode with its own platform's default, full when that platform has none", async () => {
      const harness = await createHarness({
        defaultModes: { ios: "slim" },
        drivers: [slimmingDriver()],
      });
      const android = {
        physical: false as const,
        model: "Pixel 9",
        osVersion: "35",
        platform: "android" as const,
      };

      expect(harness.coordinator.servesDefaultMode(android)).toBe(true);
      expect(harness.coordinator.servesDefaultMode({ ...android, mode: "slim" })).toBe(false);
    });

    it.each(["ios", "android"] as const)(
      "reports servesDefaultMode false for a physical spec on %s, though it names no mode and the platform's default is full",
      async (platform) => {
        const harness = await createHarness({ defaultModes: { [platform]: "full" } });

        expect(
          harness.coordinator.servesDefaultMode({
            class: "phone",
            model: "Some Phone",
            osVersion: "1",
            physical: true,
            platform,
          }),
        ).toBe(false);
      },
    );

    it("passes the resolved mode to resolveSpec, the default filled in for a request that named none", async () => {
      const driver = slimmingDriver();
      const harness = await createHarness({ defaultModes: { ios: "slim" }, drivers: [driver] });

      await harness.coordinator.request(request, owner("agent"));

      const resolved = driver.calls.find((call) => call.operation === "resolveSpec");
      expect(resolved?.arguments[0]).toMatchObject({ mode: "slim" });
    });

    it("never plans a full request onto a slim spec, even when the driver's resolveSpec returns one", async () => {
      class AlwaysSlimDriver extends FakeDriver {
        override async resolveSpec(
          ...args: Parameters<FakeDriver["resolveSpec"]>
        ): Promise<VirtualSpec> {
          return { ...(await super.resolveSpec(...args)), mode: "slim" };
        }
      }
      const driver = new AlwaysSlimDriver({
        availableOsVersions: ["26.5"],
        clock: new FakeClock(1_000),
        platform: "ios",
      });
      const harness = await createHarness({ drivers: [driver] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "full" },
        owner("agent"),
      );

      expect(granted.device.spec).not.toHaveProperty("mode");
      const provisioned = driver.calls.find((call) => call.operation === "provision");
      expect(provisioned?.arguments[0]).not.toHaveProperty("mode");
    });

    it.each([
      { name: "full request an idle slim", seeded: "slim", requested: "full" },
      { name: "slim request an idle full", seeded: "full", requested: "slim" },
    ] as const)(
      "does not give a $name device of the same model and runtime",
      async ({ seeded, requested }) => {
        const harness = await createHarness({ drivers: [slimmingDriver()], maxDevices: 2 });
        const idle = await seedReady(
          harness,
          seeded === "slim" ? { ...request, mode: "slim" } : request,
        );

        const granted = await harness.coordinator.request(
          { ...request, mode: requested },
          owner("agent"),
        );

        expect(granted.device.id).not.toBe(idle.id);
        expect(granted.device.mode).toBe(requested);
      },
    );

    it("resolves a slim request on a runtime the driver cannot slim to the full spec, reusing an idle full device", async () => {
      const oldRuntime = { ...request, osVersion: "17.5" };
      const harness = await createHarness({ drivers: [slimmingDriver()] });
      const full = await seedReady(harness, oldRuntime);

      const granted = await harness.coordinator.request(
        { ...oldRuntime, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.id).toBe(full.id);
      expect(granted.device.spec).toEqual(oldRuntime);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim request against a driver that knows nothing of modes a full device", async () => {
      const harness = await createHarness();

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.spec).toEqual(request);
      expect(granted.device.mode).toBe("full");
    });

    it("grants a slim-spec device whose slim pass failed as full, and keeps it in the slim pool", async () => {
      const harness = await createHarness({ drivers: [slimmingDriver({ mode: "full" })] });

      const granted = await harness.coordinator.request(
        { ...request, mode: "slim" },
        owner("agent"),
      );

      expect(granted.device.mode).toBe("full");
      expect(granted.device.spec).toEqual({ ...request, mode: "slim" });
    });
  });
});
