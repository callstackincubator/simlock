import { describe, expect, it, vi } from "vitest";
import { FakeDriver, openTestState } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { createHarness, flush, seedReady } from "./test-create-leasing.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;
type Modes = readonly ("slim" | "full")[];

const LIMITS = {
  android: { maxDevices: 1, maxRunning: 1 },
  ios: { maxDevices: 6, maxRunning: 6 },
  maxRunning: 6,
};

const phone = { model: "iPhone 16", platform: "ios" } as const;

function iosDriver(): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["26.1", "17.5"],
    clock: new FakeClock(1_000),
    knownModels: ["iPhone 15", "iPhone 16", "iPhone 17"],
    platform: "ios",
    slimmableOsVersions: ["26.1"],
  });
}

function androidDriver(): FakeDriver {
  return new FakeDriver({
    availableOsVersions: ["36"],
    clock: new FakeClock(1_000),
    knownModels: ["Pixel 9"],
    platform: "android",
  });
}

// why: the engine reads a baseline from `baselines` and copies the source the driver holds, so a row and a saved source stand in for an operator's save.
async function saveFullBaseline(harness: Harness, name: string): Promise<void> {
  const spec = { ...phone, osVersion: "26.1", physical: false } as const;
  const driverDevice = await harness.driver.provision(spec);
  const ready = await harness.driver.makeReady(driverDevice, { mode: "full", purpose: "prepare" });
  const saved = await harness.driver.saveSource({ ...ready, physical: false });
  harness.state.database
    .prepare(
      `INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id)
       VALUES (?, 1, 'ios', 'iPhone 16', '26.1', 'full', '2026-11-03T00:00:00.000Z', ?)`,
    )
    .run(name, saved.sourceId);
}

const learnedKinds = (harness: Harness) =>
  harness.engine.figures().targets.filter((target) => target.origin === "learned");

const learnCases: readonly {
  readonly kept: boolean;
  readonly learn: "android" | "full" | "full baseline" | "slim";
  readonly modes: Modes;
}[] = [
  { kept: true, learn: "android", modes: ["slim"] },
  { kept: false, learn: "full", modes: ["slim"] },
  { kept: false, learn: "full baseline", modes: ["slim"] },
  { kept: false, learn: "slim", modes: ["full"] },
  { kept: true, learn: "slim", modes: ["slim"] },
  { kept: true, learn: "full", modes: ["slim", "full"] },
];

// why: a worker that learned a kind while it served both modes, then restarts serving fewer, on the same state.
async function learnedAfterSwitch(
  learn: "android" | "full" | "full baseline" | "slim",
  modes: Modes,
): Promise<number> {
  const state = await openTestState();
  const ios = iosDriver();
  const options = {
    driver: ios,
    drivers: [ios, androidDriver()],
    limits: LIMITS,
    startPool: true,
    state,
    warmPool: { baselineLearnAfter: 1 },
  };
  const before = await createHarness(options);
  if (learn === "full baseline") await saveFullBaseline(before, "checkout");
  const asked =
    learn === "android"
      ? { model: "Pixel 9", osVersion: "36", platform: "android" as const }
      : learn === "full baseline"
        ? { baseline: "checkout", platform: "ios" as const }
        : { ...phone, mode: learn, osVersion: "26.1" };
  const grant = await before.engine.request(asked, { ownerId: "learner", requesterId: "learner" });
  await before.engine.release(grant.lease.id, "explicit");
  await flush();
  await before.engine.core.passWarmPool();
  expect(learnedKinds(before), learn).toHaveLength(1);
  before.engine.dispose();

  const after = await createHarness({ ...options, firstId: 5_000, iosModes: modes });
  await after.engine.core.passWarmPool();
  await after.engine.settle();
  return learnedKinds(after).length;
}

async function idleFullDeviceIsTargeted(modes: Modes): Promise<boolean> {
  const harness = await createHarness({
    driver: iosDriver(),
    iosModes: modes,
    limits: LIMITS,
    startPool: true,
    warmPool: {
      targets: [{ count: 1, mode: "full", model: "iPhone 16", osVersion: "26.1", platform: "ios" }],
    },
  });
  const idle = await seedReady(harness, { ...phone, osVersion: "26.1", physical: false });
  await harness.engine.core.passWarmPool();
  await harness.engine.settle();
  return (await harness.engine.core.targetedDevices()).has(idle.id);
}

describe("the warm pool on a worker that does not serve every iOS mode", () => {
  it("reports a full target, and a mode-less target on iOS below 18.5, short mode-unavailable and boots nothing for them, fills a slim target, forgets a learned kind whose mode is not served, and stops sparing an idle full device", async () => {
    const driver = iosDriver();
    const harness = await createHarness({
      driver,
      iosModes: ["slim"],
      limits: LIMITS,
      startPool: true,
      warmPool: {
        targets: [
          { count: 1, mode: "full", model: "iPhone 16", osVersion: "26.1", platform: "ios" },
          { count: 1, model: "iPhone 15", osVersion: "17.5", platform: "ios" },
          { count: 1, mode: "slim", model: "iPhone 17", osVersion: "26.1", platform: "ios" },
        ],
      },
    });
    await harness.engine.core.passWarmPool();
    await vi.waitFor(() =>
      expect(
        harness.engine.figures().targets.find((target) => target.model === "iPhone 17"),
      ).toMatchObject({ ready: 1 }),
    );
    await harness.engine.settle();

    const byModel = (model: string) =>
      harness.engine.figures().targets.find((target) => target.model === model);
    expect(byModel("iPhone 16")).toMatchObject({ booting: 0, ready: 0, short: "mode-unavailable" });
    expect(byModel("iPhone 15")).toMatchObject({ booting: 0, ready: 0, short: "mode-unavailable" });
    expect(byModel("iPhone 17")).toMatchObject({ mode: "slim", ready: 1 });
    expect(byModel("iPhone 17")).not.toHaveProperty("short");
    expect(driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(1);

    for (const { kept, learn, modes } of learnCases) {
      expect(await learnedAfterSwitch(learn, modes), `${learn} on ${JSON.stringify(modes)}`).toBe(
        kept ? 1 : 0,
      );
    }

    expect([
      await idleFullDeviceIsTargeted(["slim", "full"]),
      await idleFullDeviceIsTargeted(["slim"]),
    ]).toEqual([true, false]);
  });

  it("doctor reports a warm target the worker cannot meet because it does not serve its mode, naming the refused mode, the list and the way out, and nothing when the mode is served", async () => {
    const findings = async (
      modes: Modes | undefined,
      target: { readonly mode?: "slim" | "full"; readonly osVersion: string },
    ) => {
      const harness = await createHarness({
        driver: iosDriver(),
        ...(modes === undefined ? {} : { iosModes: modes }),
        limits: LIMITS,
        startPool: true,
        warmPool: { targets: [{ count: 1, model: "iPhone 16", platform: "ios", ...target }] },
      });
      await harness.engine.core.passWarmPool();
      await harness.engine.settle();
      const report = await harness.engine.core.doctor.reconcile();
      return report.findings.filter((finding) => finding.kind === "warm-pool-target-unreachable");
    };
    const unreachable = (named: string, mode: string, list: string) => [
      {
        kind: "warm-pool-target-unreachable",
        message: `${named} cannot be met: this worker does not serve ${mode} iOS simulators (ios.modes is ${list})`,
        platform: "ios",
        reason: "mode-unavailable",
        remedy: `remove the target from warmPool.targets, or add ${mode} to ios.modes`,
        target: named,
      },
    ];

    expect(await findings(["slim"], { mode: "full", osVersion: "26.1" })).toEqual(
      unreachable("iPhone 16 / 26.1 / full", "full", '["slim"]'),
    );
    expect(await findings(["full"], { mode: "slim", osVersion: "26.1" })).toEqual(
      unreachable("iPhone 16 / 26.1 / slim", "slim", '["full"]'),
    );
    // why: iOS below 18.5 cannot be slimmed, so a slim ask (asked or default) is refused as the full it falls back to.
    expect(await findings(["slim"], { osVersion: "17.5" })).toEqual(
      unreachable("iPhone 16 / 17.5 / slim", "full", '["slim"]'),
    );
    expect(await findings(["slim"], { mode: "slim", osVersion: "17.5" })).toEqual(
      unreachable("iPhone 16 / 17.5 / slim", "full", '["slim"]'),
    );
    expect(await findings(undefined, { mode: "full", osVersion: "26.1" })).toEqual([]);
    expect(await findings(undefined, { mode: "slim", osVersion: "26.1" })).toEqual([]);
  });
});
