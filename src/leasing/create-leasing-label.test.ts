import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "../core/testing.js";
import { request, createHarness, seedReady } from "./test-create-leasing.js";

describe("createLeasing: a lease's label reaches the driver's boot", () => {
  const slim = { ...request, mode: "slim", except: ["store"] } as const;
  const slimSpec = { ...request, mode: "slim", physical: false } as const;

  async function build() {
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock: new FakeClock(1_000),
      platform: "ios",
      slimmableOsVersions: ["26.5"],
    });
    return createHarness({ driver, iosModes: ["full", "slim"] });
  }

  const cases = [
    { name: "provision", seed: "none", ask: request, xcodeSet: false },
    { name: "boot of a shut-down device", seed: "shutdown", ask: request, xcodeSet: false },
    { name: "reboot on Xcode's set", seed: "ready", ask: request, xcodeSet: true },
    { name: "reboot for an except lease", seed: "slim", ask: slim, xcodeSet: false },
  ] as const;

  async function seeded(harness: Awaited<ReturnType<typeof build>>, seed: string) {
    if (seed === "ready") await seedReady(harness);
    if (seed === "slim") await seedReady(harness, slimSpec, "slim");
    if (seed !== "shutdown") return;
    const device = await seedReady(harness);
    await harness.registry.transitionDevice(device.id, "shutdown", {
      event: "device.shutdown",
      payload: { deviceId: device.id, initiator: "test" },
    });
  }

  /** why: the options of the one `makeReady` a lease of this case made, with or without a label. */
  async function bootOptionsOf(c: (typeof cases)[number], label: string | undefined) {
    const harness = await build();
    if (c.xcodeSet) {
      Object.defineProperty(harness.driver, "rebootReadyBeforeGrant", { value: true });
    }
    await seeded(harness, c.seed);
    const before = harness.driver.calls.length;
    await harness.engine.request(c.ask, {
      ownerId: "o",
      requesterId: "r",
      ...(label === undefined ? {} : { label }),
    });
    const boots = harness.driver.calls
      .slice(before)
      .filter((call) => call.operation === "makeReady");
    expect(boots, c.name).toHaveLength(1);
    return boots[0]!.arguments[1] as { label?: string };
  }

  it("passes the request's label to makeReady on a provision, a boot and a reboot, and none without one", async () => {
    for (const c of cases) {
      expect((await bootOptionsOf(c, "feature-x")).label, `${c.name} with a label`).toBe(
        "feature-x",
      );
      expect(await bootOptionsOf(c, undefined), `${c.name} without one`).not.toHaveProperty(
        "label",
      );
    }
  });
});
