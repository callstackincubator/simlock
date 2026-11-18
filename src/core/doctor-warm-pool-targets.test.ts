import { describe, expect, it } from "vitest";
import { EventBus } from "../bus/index.js";
import { FakeClock } from "../ports/index.js";
import { type Config } from "./config.js";
import { Doctor, type DoctorFinding } from "./doctor.js";
import { FakeDriver } from "./fake-driver.js";
import { SerializedDecision } from "./serialized-decision.js";
import { config, loadRegistry } from "./test-doctor.js";

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor: warm pool targets", () => {
  const entry = (maxRunning: number) => ({
    maxRunning,
    overLimit: false,
    reserved: 0,
    running: 0,
  });
  const limits = (limit: { ios?: number; android?: number; global?: number }) => ({
    android: entry(limit.android ?? 10),
    global: entry(limit.global ?? 20),
    ios: entry(limit.ios ?? 10),
  });
  const figuresOf = (
    targets: readonly {
      model: string;
      origin?: "configured" | "learned";
      osVersion?: string;
      platform?: "ios" | "android";
      short?: "runtime-missing" | "unknown-model" | "ram-budget";
    }[],
  ) => ({
    enabled: true,
    reserveRunning: { android: 0, ios: 0 },
    targets: targets.map((target) => ({
      booting: 0,
      count: 1,
      mode: "full" as const,
      origin: "configured" as const,
      platform: "ios" as const,
      ready: 0,
      ...target,
    })),
  });

  async function findings(options: {
    readonly targets?: Config["warmPool"]["targets"];
    readonly reserve?: { ios: number; android: number };
    readonly enabled?: boolean;
    readonly limit?: { ios?: number; android?: number; global?: number };
    readonly figures?: ReturnType<typeof figuresOf>;
    readonly driver?: Omit<ConstructorParameters<typeof FakeDriver>[0], "clock">;
    readonly virtualDevices?: Partial<Record<"ios" | "android", boolean>>;
  }): Promise<DoctorFinding[]> {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const base = config();
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: {
        ...base,
        android: { virtualDevices: options.virtualDevices?.android ?? true },
        ios: { ...base.ios, virtualDevices: options.virtualDevices?.ios ?? true },
        warmPool: {
          ...base.warmPool,
          enabled: options.enabled ?? true,
          reserveRunning: options.reserve ?? { android: 0, ios: 0 },
          targets: options.targets ?? [],
        },
      },
      drivers: [new FakeDriver({ clock, platform: "ios", ...options.driver })],
      eventBus,
      registry,
      warmPool: {
        figures: () => options.figures ?? figuresOf([]),
        runningCapacity: () => limits(options.limit ?? {}),
      },
    });
    const report = await doctor.reconcile();
    return report.findings.filter((finding) => finding.kind === "warm-pool-target-unreachable");
  }

  it("reports a configured target short with runtime-missing as unreachable, naming the install command, and no learned entry, even one short runtime-missing", async () => {
    const found = await findings({
      figures: figuresOf([
        { model: "iPhone 17", osVersion: "26.0" },
        { model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" },
        { model: "iPhone 16", origin: "learned", osVersion: "27.0", short: "runtime-missing" },
        { model: "iPhone 15", origin: "learned", osVersion: "26.0", short: "unknown-model" },
      ]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "iOS 27.0 is not installed",
        platform: "ios",
        reason: "runtime-missing",
        remedy: "run simlock component install ios 27.0",
        target: "iPhone 17 / 27.0 / full",
      },
    ]);
  });

  it.each([
    ["ios", "iOS", "iPhone 17", ["18.0", "26.0"], "26.0"],
    ["android", "Android", "Television (1080p)", ["34", "35"], "35"],
  ] as const)(
    "names simlock catalog, not component install, for an installed %s version the target's model does not pair with",
    async (platform, name, model, runtimes, unpaired) => {
      const found = await findings({
        driver: {
          availableOsVersions: [...runtimes],
          knownModels: [model],
          modelRuntimes: { [model]: runtimes.filter((runtime) => runtime !== unpaired) },
          platform,
        },
        figures: figuresOf([{ model, osVersion: unpaired, platform, short: "runtime-missing" }]),
      });

      expect(found).toStrictEqual([
        {
          kind: "warm-pool-target-unreachable",
          message: `${model} does not pair with ${name} ${unpaired}`,
          platform,
          reason: "runtime-missing",
          remedy: `run simlock catalog --platform ${platform}`,
          target: `${model} / ${unpaired} / full`,
        },
      ]);
    },
  );

  it("keeps the install text for a version the platform's catalog does not list", async () => {
    const found = await findings({
      driver: {
        availableOsVersions: ["26.0"],
        knownModels: ["iPhone 17"],
        platform: "ios",
      },
      figures: figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message: "iOS 27.0 is not installed",
        remedy: "run simlock component install ios 27.0",
      }),
    ]);
  });

  it("names <platform>.virtualDevices for a configured target on a phones-only platform, and keeps today's findings with the key true or on the other platform", async () => {
    const androidTarget = { model: "Pixel 9", osVersion: "36", platform: "android" } as const;
    const target = "Pixel 9 / 36 / full";

    const off = await findings({
      figures: figuresOf([{ ...androidTarget, short: "unknown-model" }]),
      virtualDevices: { android: false },
    });
    const on = await findings({
      figures: figuresOf([{ ...androidTarget, short: "unknown-model" }]),
    });
    const otherOff = await findings({
      figures: figuresOf([{ model: "iPhone 99", osVersion: "26.0", short: "unknown-model" }]),
      virtualDevices: { android: false },
    });

    expect(off).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: `${target} cannot be met: android.virtualDevices is false`,
        platform: "android",
        reason: "unknown-model",
        remedy: "remove the target from warmPool.targets, or set android.virtualDevices true",
        target,
      },
    ]);
    expect(on).toStrictEqual([
      expect.objectContaining({
        message: "Pixel 9 is not a known Android model",
        reason: "unknown-model",
      }),
    ]);
    expect(otherOff).toStrictEqual([
      expect.objectContaining({
        message: "iPhone 99 is not a known iOS model",
        platform: "ios",
      }),
    ]);
  });

  it("leaves a phones-only platform's reserveRunning out of the room the targets are checked against", async () => {
    const ask = (virtualDevices: boolean) =>
      findings({
        limit: { global: 2 },
        reserve: { android: 2, ios: 0 },
        targets: [{ count: 2, model: "iPhone 17", platform: "ios" }],
        virtualDevices: { android: virtualDevices },
      });

    expect(await ask(true)).toStrictEqual([
      expect.objectContaining({ reason: "over-limit", target: "all targets" }),
    ]);
    expect(await ask(false)).toStrictEqual([]);
  });

  it("reports a target short with unknown-model as unreachable", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 99", osVersion: "26.0", short: "unknown-model" }]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        kind: "warm-pool-target-unreachable",
        platform: "ios",
        reason: "unknown-model",
        target: "iPhone 99 / 26.0 / full",
      }),
    ]);
  });

  it("reports one finding for two iOS targets of 2 on a running limit of 3, naming the sum and the limit", async () => {
    const found = await findings({
      limit: { ios: 3 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 2, model: "iPhone 16", platform: "ios" },
      ],
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message:
          "the ios targets want 4 running devices, and the ios running limit is 3, leaving room for 3",
        platform: "ios",
        reason: "over-limit",
        remedy: "lower the counts of the ios warmPool.targets, or raise the ios running limit",
        target: "ios targets",
      },
    ]);
  });

  it("names the reserve a platform's limit holds back, and offers lowering it", async () => {
    const found = await findings({
      limit: { ios: 3 },
      reserve: { android: 0, ios: 1 },
      targets: [{ count: 3, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the ios targets want 3 running devices, and the ios running limit is 3, of which warmPool.reserveRunning holds 1, leaving room for 2",
        remedy:
          "lower the counts of the ios warmPool.targets, raise the ios running limit, or lower warmPool.reserveRunning",
      }),
    ]);
  });

  it("names the summed reserves in the machine's finding", async () => {
    const found = await findings({
      limit: { android: 5, global: 4, ios: 5 },
      reserve: { android: 1, ios: 1 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 1, model: "Pixel 8", platform: "android" },
      ],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the targets want 3 running devices, and the running limit is 4, of which warmPool.reserveRunning holds 2, leaving room for 2",
        target: "all targets",
      }),
    ]);
  });

  it("caps a platform's reserve at its running limit, so a platform with no targets is not over it", async () => {
    const noTargets = await findings({
      limit: { global: 5, ios: 2 },
      reserve: { android: 0, ios: 4 },
    });
    expect(noTargets).toEqual([]);
    expect(
      await findings({
        limit: { global: 5, ios: 2 },
        reserve: { android: 0, ios: 4 },
        targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
      }),
    ).toEqual([
      expect.objectContaining({
        message:
          "the ios targets want 1 running devices, and the ios running limit is 2, of which warmPool.reserveRunning holds 2, leaving room for 0",
        platform: "ios",
      }),
    ]);
  });

  it("reports nothing for reserves that add up past the machine's limit when no target is configured", async () => {
    const limit = { android: 5, global: 4, ios: 5 };
    const reserve = { android: 2, ios: 3 };

    expect(await findings({ limit, reserve })).toEqual([]);
  });

  it("caps the machine's reserve at its running limit, so a target past it leaves room for zero and never below", async () => {
    const found = await findings({
      limit: { android: 5, global: 4, ios: 5 },
      reserve: { android: 2, ios: 3 },
      targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message:
          "the targets want 1 running devices, and the running limit is 4, of which warmPool.reserveRunning holds 4, leaving room for 0",
        target: "all targets",
      }),
    ]);
  });

  it("prints no install command for a target whose OS is a range, which names no version to install", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 17", osVersion: ">=27", short: "runtime-missing" }]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "no installed iOS runtime satisfies >=27",
        platform: "ios",
        reason: "runtime-missing",
        remedy:
          "run simlock component list --platform ios to see the versions, then simlock component install ios <version> for one inside >=27",
        target: "iPhone 17 / >=27 / full",
      },
    ]);
  });

  it("takes the platform's reserve off the room its targets have", async () => {
    const targets = [{ count: 3, model: "iPhone 17", platform: "ios" as const }];

    expect(await findings({ limit: { ios: 3 }, reserve: { android: 0, ios: 1 }, targets })).toEqual(
      [expect.objectContaining({ platform: "ios", reason: "over-limit" })],
    );
    expect(await findings({ limit: { ios: 3 }, targets })).toEqual([]);
  });

  it("reports one finding for targets that fit each platform but not the machine's running limit together", async () => {
    const found = await findings({
      limit: { android: 5, global: 3, ios: 5 },
      targets: [
        { count: 2, model: "iPhone 17", platform: "ios" },
        { count: 2, model: "Pixel 8", platform: "android" },
      ],
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message:
          "the targets want 4 running devices, and the running limit is 3, leaving room for 3",
        reason: "over-limit",
        remedy: "lower the counts of the warmPool.targets, or raise the running limit",
        target: "all targets",
      },
    ]);
  });

  it("pins the unknown-model message and remedy, naming the model and the platform", async () => {
    const found = await findings({
      figures: figuresOf([
        {
          model: "Pixel 99",
          osVersion: "35",
          platform: "android",
          short: "unknown-model",
        },
      ]),
    });

    expect(found).toStrictEqual([
      {
        kind: "warm-pool-target-unreachable",
        message: "Pixel 99 is not a known Android model",
        platform: "android",
        reason: "unknown-model",
        remedy: "run simlock catalog --platform android to list the models",
        target: "Pixel 99 / 35 / full",
      },
    ]);
  });

  it("names an Android runtime as Android, and a target that names no OS without one", async () => {
    const found = await findings({
      figures: figuresOf([
        {
          model: "Pixel 8",
          osVersion: "35",
          platform: "android",
          short: "runtime-missing",
        },
        { model: "iPhone 17", short: "runtime-missing" },
        { model: "iPhone 99", short: "unknown-model" },
      ]),
    });

    expect(found).toStrictEqual([
      expect.objectContaining({
        message: "Android 35 is not installed",
        remedy: "run simlock component install android 35",
      }),
      {
        kind: "warm-pool-target-unreachable",
        message: "iOS runtime is not installed",
        platform: "ios",
        reason: "runtime-missing",
        remedy:
          "run simlock component list --platform ios to see the versions, then simlock component install ios <version>",
        target: "iPhone 17 / full",
      },
      expect.objectContaining({ target: "iPhone 99 / full" }),
    ]);
  });

  it("takes both reserves off the machine's room, and reports nothing for targets that exactly fill what is left", async () => {
    const reserve = { android: 1, ios: 1 };
    const targets = (ios: number) => [
      { count: ios, model: "iPhone 17", platform: "ios" as const },
      { count: 1, model: "Pixel 8", platform: "android" as const },
    ];
    const limit = { android: 5, global: 4, ios: 5 };

    expect(await findings({ limit, reserve, targets: targets(2) })).toEqual([
      expect.objectContaining({ reason: "over-limit", target: "all targets" }),
    ]);
    expect(await findings({ limit, reserve, targets: targets(1) })).toEqual([]);
    expect(
      await findings({
        limit: { ios: 3 },
        targets: [{ count: 3, model: "iPhone 17", platform: "ios" }],
      }),
    ).toEqual([]);
  });

  it("does not report a target short for ram-budget, or one that fits", async () => {
    const found = await findings({
      figures: figuresOf([{ model: "iPhone 17", osVersion: "26.0", short: "ram-budget" }]),
      targets: [{ count: 1, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toEqual([]);
  });

  it("reports nothing with the pool off", async () => {
    const found = await findings({
      enabled: false,
      figures: figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
      limit: { ios: 1 },
      targets: [{ count: 5, model: "iPhone 17", platform: "ios" }],
    });

    expect(found).toEqual([]);
  });

  it("leaves the finding out of the doctor.reconciled event's driftFindings, which keeps the drift beside it", async () => {
    const clock = new FakeClock(10_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.setManagedReality({
      devices: [
        {
          address: "simlock-orphan-address",
          deviceId: "simlock-orphan",
          driverData: { fakeDeviceId: "simlock-orphan" },
          runState: "running",
        },
      ],
      processes: [],
    });
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    const base = config();
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: base,
      drivers: [driver],
      eventBus,
      registry,
      warmPool: {
        figures: () =>
          figuresOf([{ model: "iPhone 17", osVersion: "27.0", short: "runtime-missing" }]),
        runningCapacity: () => limits({}),
      },
    });

    const report = await doctor.reconcile();

    const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
    expect(report.findings.map((finding) => finding.kind).sort()).toEqual([
      "orphan-device",
      "warm-pool-target-unreachable",
    ]);
    expect(reconciled?.payload).toMatchObject({ driftFindings: [{ kind: "orphan-device" }] });
    expect(reconciled?.payload).toHaveProperty("driftFindings.length", 1);
  });
});
