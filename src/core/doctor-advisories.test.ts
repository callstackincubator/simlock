import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { DRIVER_DETAIL_MAX } from "../contract/index.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import {
  Doctor,
  type DoctorFinding,
  type DoctorReport,
  type OptionalModuleFinding,
} from "./doctor.js";
import type { PrerequisiteCheck } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { SerializedDecision } from "./serialized-decision.js";
import { loadTestRegistry } from "./testing.js";
import {
  config,
  loadRegistry,
  readyDevice,
  readyIosDevice,
  rootRejection,
  sequence,
} from "./test-doctor.js";

function withAdvisories(
  driver: FakeDriver,
  advisories: readonly { readonly code: string; readonly message: string }[],
): FakeDriver {
  return Object.assign(driver, { advisories: () => Promise.resolve(advisories) });
}

// why: pure logic with many cases: Doctor's drift, stall and finding classification, built
// directly over a fake driver and a test registry rather than a whole daemon.
describe("Doctor", () => {
  it("reports a platform whose driver refused to start, with the reason it refused", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile();
    const long = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [],
      driverRejections: [{ ...rootRejection(), summary: "x".repeat(5000) }],
      eventBus,
      registry,
    }).reconcile();

    const longDetail = (long.findings[0] as { detail: string }).detail;
    expect(longDetail.length).toBeLessThanOrEqual(DRIVER_DETAIL_MAX);
    expect(longDetail).toMatch(
      /…\. Driver discovery runs once.*restart the daemon.*unavailable\.$/,
    );
    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(report.findings[0]).toMatchObject({
      // why: Discovery happens once, at startup, so the finding has to say what actually
      // retries the platform -- otherwise repairing the root and re-running `doctor`
      // reports the identical line and reads as a repair that did not work.
      detail: expect.stringContaining(
        "Refusing the ios device root /Devices: it carries no marker",
      ),
      platform: "ios",
      reason: "missing-marker",
    });
    expect(report.findings[0]).toMatchObject({
      detail: expect.stringContaining("restart the daemon"),
    });
  });

  it("leaves a refused driver alone under --fix, since adopting it is the refusal's point", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadTestRegistry({
      clock,
      eventBus,
      idGenerator: sequence(),
    });

    const report = await new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [],
      driverRejections: [rootRejection()],
      eventBus,
      registry,
    }).reconcile({ fix: true });

    expect(report.findings.map((finding) => finding.kind)).toEqual(["driver-unavailable"]);
    expect(registry.snapshot.devices).toEqual([]);
  });

  describe("driver advisories", () => {
    it("collects driver-advisory findings from a driver that implements advisories()", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "iOS 17.0 predates the 18.5 floor" },
      ]);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings).toEqual([
        {
          code: "slim-runtime-unsupported",
          kind: "driver-advisory",
          message: "iOS 17.0 predates the 18.5 floor",
          platform: "ios",
        },
      ]);
    });

    it("contributes nothing from a driver that has no advisories() method", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = new FakeDriver({ clock, platform: "ios" });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "driver-advisory")).toEqual([]);
    });

    it("tolerates a rejecting advisories() without failing the rest of reconcile", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const registered = await registry.registerDevice({
        backend: "local",
        driverData: { fakeDeviceId: "missing" },
        driverDeviceId: "missing",
        provisionDuration: 0,
        spec: { physical: false, model: "Phone", osVersion: "1", platform: "ios" },
      });
      await registry.transitionDevice(registered.id, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: registered.id },
      });
      const driver = Object.assign(new FakeDriver({ clock, platform: "ios" }), {
        advisories: () => Promise.reject(new Error("advisories boom")),
      });

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      expect(report.findings.filter((finding) => finding.kind === "driver-advisory")).toEqual([]);
      expect(report.findings.map((finding) => finding.kind)).toContain("registry-device-missing");
    });

    it("--fix never acts on a driver-advisory finding", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      const report = await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile({ fix: true });

      expect(report.findings).toEqual([
        {
          code: "slim-runtime-unsupported",
          kind: "driver-advisory",
          message: "detail",
          platform: "ios",
        },
      ]);
      expect(
        driver.calls
          .map((call) => call.operation)
          .filter((operation) => operation !== "listSources"),
      ).toEqual(["listManaged"]);
    });

    it("excludes driver-advisory findings from the doctor.reconciled event's driftFindings", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadTestRegistry({
        clock,
        eventBus,
        idGenerator: sequence(),
      });
      const driver = withAdvisories(new FakeDriver({ clock, platform: "ios" }), [
        { code: "slim-runtime-unsupported", message: "detail" },
      ]);

      await new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [driver],
        eventBus,
        registry,
      }).reconcile();

      const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
      expect(reconciled).toBeDefined();
      const payload = reconciled!.payload as {
        readonly driftFindings: readonly { readonly kind: string }[];
      };
      expect(payload.driftFindings.some((finding) => finding.kind === "driver-advisory")).toBe(
        false,
      );
    });
  });

  describe("prerequisites", () => {
    const EMULATOR = {
      message: "The Android emulator package is not installed.",
      prerequisite: "android-emulator",
      remedy: "Run `sdkmanager --install emulator`.",
    };
    const RESTART = /restart the daemon/;

    function prerequisiteCheck(
      platform: "ios" | "android",
      missing: readonly (typeof EMULATOR)[] = [],
    ): PrerequisiteCheck & { runs: number } {
      const check = {
        check: () => {
          check.runs += 1;
          return Promise.resolve(missing);
        },
        platform,
        runs: 0,
      };
      return check;
    }

    async function doctorWith(
      options: Partial<ConstructorParameters<typeof Doctor>[0]> = {},
    ): Promise<{ readonly doctor: Doctor; readonly eventBus: EventBus }> {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const registry = await loadRegistry(clock, eventBus);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [
          new FakeDriver({ clock, platform: "ios" }),
          new FakeDriver({ clock, platform: "android" }),
        ],
        eventBus,
        registry,
        ...options,
      });
      return { doctor, eventBus };
    }

    function prerequisiteFindings(report: DoctorReport) {
      return report.findings.filter((finding) => finding.kind === "prerequisite-missing");
    }

    it("reports no prerequisite-missing finding with every prerequisite present and both platforms running", async () => {
      const checks = [prerequisiteCheck("ios"), prerequisiteCheck("android")];
      const { doctor } = await doctorWith({ prerequisiteChecks: checks });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(checks.map((check) => check.runs)).toEqual([1, 1]);
      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("reports what a running platform's check finds missing, carrying the driver's text unread", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("android", [EMULATOR])],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([
        { kind: "prerequisite-missing", platform: "android", ...EMULATOR },
      ]);
    });

    it("yields no finding from a check that rejects, and does not fail the run", async () => {
      const failing: PrerequisiteCheck = {
        check: () => Promise.reject(new Error("xcodebuild timed out")),
        platform: "ios",
      };
      const { doctor } = await doctorWith({
        driverRejections: [rootRejection()],
        prerequisiteChecks: [failing, prerequisiteCheck("android", [EMULATOR])],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report).map((finding) => finding.platform)).toEqual(["android"]);
      expect(report.findings.map((finding) => finding.kind)).toContain("driver-unavailable");
    });

    it("gives a platform with nothing missing and no running driver one daemon-restart finding", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("ios"), prerequisiteCheck("android")],
        runningPlatforms: () => ["ios"],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([
        expect.objectContaining({
          platform: "android",
          prerequisite: "daemon-restart",
          remedy: expect.stringMatching(RESTART) as unknown,
        }),
      ]);
    });

    it("gives a platform with a driver rejection no daemon-restart finding", async () => {
      const { doctor } = await doctorWith({
        driverRejections: [rootRejection()],
        prerequisiteChecks: [prerequisiteCheck("ios"), prerequisiteCheck("android")],
        runningPlatforms: () => ["android"],
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("tells the operator to restart the daemon on a finding for a platform that is not running, and not on one that is", async () => {
      const { doctor } = await doctorWith({
        prerequisiteChecks: [
          prerequisiteCheck("ios", [{ ...EMULATOR, prerequisite: "xcode" }]),
          prerequisiteCheck("android", [EMULATOR]),
        ],
        runningPlatforms: () => ["ios"],
      });

      const report = await doctor.reconcile({ prerequisites: true });
      const [ios, android] = prerequisiteFindings(report) as Extract<
        DoctorFinding,
        { readonly kind: "prerequisite-missing" }
      >[];

      expect(ios?.remedy).toBe(EMULATOR.remedy);
      expect(android?.remedy.startsWith(EMULATOR.remedy)).toBe(true);
      expect(android?.remedy).toMatch(RESTART);
    });

    it("reports the same prerequisite findings with fix: true and asks the driver for nothing but listManaged", async () => {
      const clock = new FakeClock(10_000);
      const eventBus = new EventBus(clock);
      const android = new FakeDriver({ clock, platform: "android" });
      const check = prerequisiteCheck("android", [EMULATOR]);
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock,
        config: config(),
        drivers: [android],
        eventBus,
        prerequisiteChecks: [check],
        registry: await loadRegistry(clock, eventBus),
      });

      const plain = await doctor.reconcile({ prerequisites: true });
      const fixed = await doctor.reconcile({ fix: true, prerequisites: true });

      expect(prerequisiteFindings(fixed)).toEqual(prerequisiteFindings(plain));
      expect(prerequisiteFindings(fixed)).toHaveLength(1);
      expect(
        android.calls
          .map((call) => call.operation)
          .filter((operation) => operation !== "listSources"),
      ).toEqual(["listManaged", "listManaged"]);
      expect(check.runs).toBe(2);
    });

    it("applies --fix before any prerequisite check runs, so a slow check never delays a fix", async () => {
      const { eventBus, registry } = await readyIosDevice();
      const deviceId = registry.snapshot.devices[0]!.id;
      await registry.createLease({
        deviceId,
        ownerId: "agent",
        requesterId: "agent",
        ttlDeadline: 9_000,
        ttlMs: 60_000,
      });
      const order: string[] = [];
      const doctor = new Doctor({
        decisions: new SerializedDecision(),
        clock: new FakeClock(10_000),
        config: config(),
        drivers: [],
        eventBus,
        leaseExpirer: {
          expire: (leaseId: string) => {
            order.push(`expire ${leaseId}`);
            return Promise.resolve();
          },
        },
        prerequisiteChecks: [
          {
            check: () => {
              order.push("check");
              return Promise.resolve([]);
            },
            platform: "android",
          },
        ],
        registry,
      });

      await doctor.reconcile({ fix: true, prerequisites: true });

      expect(order).toEqual([`expire ${registry.snapshot.leases[0]!.id}`, "check"]);
    });

    it("runs no prerequisite check when reconcile is not asked to", async () => {
      const check = prerequisiteCheck("android", [EMULATOR]);
      const { doctor } = await doctorWith({ prerequisiteChecks: [check] });

      const report = await doctor.reconcile();

      expect(check.runs).toBe(0);
      expect(prerequisiteFindings(report)).toEqual([]);
    });

    it("a service check that throws adds no finding and does not fail the run", async () => {
      const { doctor } = await doctorWith({
        serviceCheck: {
          manager: "launchd",
          name: "com.callstack.simlock.worker",
          check: async () => {
            throw new Error("launchctl timed out");
          },
        },
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(report.findings.map((finding) => finding.kind)).not.toContain("service-broken");
    });

    it("leaves prerequisite-missing and service-broken findings out of doctor.reconciled", async () => {
      const { doctor, eventBus } = await doctorWith({
        prerequisiteChecks: [prerequisiteCheck("android", [EMULATOR])],
        serviceCheck: {
          manager: "launchd",
          name: "com.callstack.simlock.worker",
          check: async () => ["/gone/node"],
        },
      });

      const report = await doctor.reconcile({ prerequisites: true });

      expect(prerequisiteFindings(report)).toHaveLength(1);
      expect(report.findings.map((finding) => finding.kind)).toContain("service-broken");
      const reconciled = eventBus.replay().find((event) => event.event === "doctor.reconciled");
      const payload = reconciled!.payload as {
        readonly driftFindings: readonly { readonly kind: string }[];
      };
      expect(payload.driftFindings).toEqual([]);
    });
  });
});

describe("Doctor: optional module findings", () => {
  const unavailable: OptionalModuleFinding = {
    kind: "module-unavailable",
    module: "agent-device",
    message: "found 0.20.3, need 0.21.28 or later",
    remedy: "install agent-device 0.21.28 or later, then restart the daemon",
  };

  async function setup(
    options: {
      readonly optionalModules?: () => readonly OptionalModuleFinding[];
      readonly orphan?: boolean;
      readonly missing?: boolean;
      readonly sink?: MemoryLogSink;
    } = {},
  ) {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const registry = await loadRegistry(clock, eventBus);
    if (options.missing === true) {
      await readyDevice(registry, "gone", "ios");
    }
    const driver = new FakeDriver({ clock, platform: "ios" });
    if (options.orphan === true) {
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
    }
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: config(),
      drivers: [driver],
      eventBus,
      registry,
      ...(options.sink === undefined
        ? {}
        : { logger: new JsonLinesLogger({ clock, level: "debug", sink: options.sink }) }),
      ...(options.optionalModules === undefined
        ? {}
        : { optionalModules: options.optionalModules }),
    });
    return { doctor, driver, eventBus, registry };
  }

  it("returns each finding optionalModules gives, with its kind, message and remedy unchanged, after a warm-pool-target-unreachable finding returned by the same run", async () => {
    const clock = new FakeClock(10_000);
    const eventBus = new EventBus(clock);
    const doctor = new Doctor({
      decisions: new SerializedDecision(),
      clock,
      config: { ...config(), warmPool: { ...config().warmPool, enabled: true } },
      drivers: [new FakeDriver({ clock, platform: "ios" })],
      eventBus,
      optionalModules: () => [unavailable],
      registry: await loadRegistry(clock, eventBus),
      warmPool: {
        figures: () => ({
          enabled: true,
          reserveRunning: { android: 0, ios: 0 },
          targets: [
            {
              booting: 0,
              count: 1,
              mode: "full" as const,
              model: "iPhone 17",
              origin: "configured" as const,
              osVersion: "27.0",
              platform: "ios" as const,
              ready: 0,
              short: "runtime-missing" as const,
            },
          ],
        }),
        runningCapacity: () => ({
          android: { maxRunning: 10, overLimit: false, reserved: 0, running: 0 },
          global: { maxRunning: 20, overLimit: false, reserved: 0, running: 0 },
          ios: { maxRunning: 10, overLimit: false, reserved: 0, running: 0 },
        }),
      },
    } as ConstructorParameters<typeof Doctor>[0]);

    const report = await doctor.reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "warm-pool-target-unreachable",
      "module-unavailable",
    ]);
    expect(report.findings.at(-1)).toStrictEqual(unavailable);
  });

  it("returns no module-unavailable finding when optionalModules is omitted or returns none", async () => {
    const omitted = await (await setup()).doctor.reconcile();
    const none = await (await setup({ optionalModules: () => [] })).doctor.reconcile();

    expect(omitted.findings).toEqual([]);
    expect(none.findings).toEqual([]);
  });

  it("reports the finding on a run where optionalModules returns it, and not on the next where it returns none", async () => {
    const answers: (readonly OptionalModuleFinding[])[] = [[unavailable], []];
    const { doctor } = await setup({ optionalModules: () => answers.shift() ?? [] });

    const first = await doctor.reconcile();
    const second = await doctor.reconcile();

    expect(first.findings).toStrictEqual([unavailable]);
    expect(second.findings).toEqual([]);
  });

  it("calls optionalModules only after fix and purge have run, with fix and purgeOrphans on, and reports its finding", async () => {
    let stateWhenCalled: string | undefined;
    let destroysWhenCalled: number | undefined;
    let registryRef: Awaited<ReturnType<typeof setup>>["registry"] | undefined;
    let driverRef: Awaited<ReturnType<typeof setup>>["driver"] | undefined;
    const harness = await setup({
      missing: true,
      optionalModules: () => {
        stateWhenCalled = registryRef?.snapshot.devices[0]?.state;
        destroysWhenCalled = driverRef?.calls.filter((call) => call.operation === "destroy").length;
        return [unavailable];
      },
      orphan: true,
    });
    registryRef = harness.registry;
    driverRef = harness.driver;

    const report = await harness.doctor.reconcile({ fix: true, purgeOrphans: true });

    expect(stateWhenCalled).toBe("deleted");
    // why: the purge destroys the orphan, so a call made before it would count no destroy.
    expect(destroysWhenCalled).toBe(1);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "registry-device-missing",
      "module-unavailable",
    ]);
  });

  it("leaves the finding out of doctor.reconciled's driftFindings and emits no other event for it", async () => {
    const withModule = await setup({ optionalModules: () => [unavailable], orphan: true });
    const without = await setup({ orphan: true });

    const report = await withModule.doctor.reconcile();
    await without.doctor.reconcile();

    expect(report.findings).toContainEqual(unavailable);

    const reconciled = withModule.eventBus
      .replay()
      .find((event) => event.event === "doctor.reconciled");
    expect(reconciled?.payload).toMatchObject({ driftFindings: [{ kind: "orphan-device" }] });
    expect(reconciled?.payload).toHaveProperty("driftFindings.length", 1);
    expect(withModule.eventBus.replay().map((event) => event.event)).toEqual(
      without.eventBus.replay().map((event) => event.event),
    );
  });

  it("logs a warning naming the error when optionalModules throws, contributes nothing, and still returns the other findings", async () => {
    const sink = new MemoryLogSink();
    const { doctor } = await setup({
      optionalModules: () => {
        throw new Error("supervisor exploded");
      },
      orphan: true,
      sink,
    });

    const report = await doctor.reconcile();

    expect(report.findings.map((finding) => finding.kind)).toEqual(["orphan-device"]);
    const warning = sink.records.find(
      (record) => record.message === "Could not read optional module findings",
    );
    expect(warning?.level).toBe("warn");
    expect(JSON.stringify(warning?.fields)).toContain("supervisor exploded");
  });
});
