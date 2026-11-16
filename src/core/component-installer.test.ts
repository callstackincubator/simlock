import { describe, expect, it, vi } from "vitest";
import type { ComponentInstallerProgress } from "./component-installer.js";
import { DriverCrashError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { createHarness, installs, flush, track, ios } from "./test-component-installer.js";

describe("ComponentInstaller", () => {
  it("admits a call synchronously, before any progress, and a throwing onAdmitted does not stop its install", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();
    const heard: string[] = [];
    void harness.installer.install(ios("27.0")).catch(() => undefined);

    const call = track(
      harness.installer.install(
        ios("28.0", {
          onAdmitted: () => {
            heard.push("admitted");
            throw new Error("observer failure");
          },
          onProgress: (progress) => heard.push(progress.stage),
        }),
      ),
    );
    expect(heard).toEqual(["admitted", "waiting"]);

    harness.ios.releaseInstalls();
    await flush();
    expect(call.result()).toEqual({ outcome: "installed", version: "28.0" });
  });

  it("refuses a platform with no driver without admitting the call", async () => {
    const harness = await createHarness();
    const onAdmitted = vi.fn();

    await expect(
      harness.installer.install({ component: "35", onAdmitted, platform: "android" }),
    ).rejects.toMatchObject({ name: "NoDriverError" });
    expect(onAdmitted).not.toHaveBeenCalled();
  });

  it("runs one install for calls that name the same component, and every call gets its outcome", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const calls = [1, 2, 3].map(() => track(harness.installer.install(ios("27.0"))));
    await flush();
    harness.ios.releaseInstalls();
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    for (const call of calls) {
      expect(call.result()).toEqual({ outcome: "installed", version: "27.0" });
    }
  });

  it("emits component.install-started and component.installed once each for an install three calls joined", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    for (const requesterId of ["a", "b", "c"]) {
      void harness.installer.install(ios("27.0", { requesterId }));
    }
    await flush();
    harness.clock.advance(5_000);
    harness.ios.releaseInstalls();
    await flush();

    expect(harness.events).toEqual([
      {
        event: "component.install-started",
        payload: { componentId: "27.0", platform: "ios", requesterId: "a" },
      },
      {
        event: "component.installed",
        payload: {
          alreadyPresent: false,
          componentId: "27.0",
          durationMs: 5_000,
          platform: "ios",
          requesterId: "a",
          version: "27.0",
        },
      },
    ]);
  });

  it("starts a second component's install on the same platform only after the first one has ended", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const first = track(harness.installer.install(ios("27.0")));
    const second = track(harness.installer.install(ios("28.0")));
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();

    expect(first.settled()).toBe(true);
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);
    expect(second.settled()).toBe(false);
    harness.ios.releaseInstalls();
    await flush();
    expect(second.result()).toEqual({ outcome: "installed", version: "28.0" });
  });

  it("tells a call that is behind another install that it is waiting, and fans the driver's progress out to every joined call", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, installProgress: [40], platform: "ios" }),
      ],
    });
    harness.ios.holdInstalls();
    const firstA: ComponentInstallerProgress[] = [];
    const firstB: ComponentInstallerProgress[] = [];
    const behind: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => firstA.push(report) }));
    void harness.installer.install(ios("27.0", { onProgress: (report) => firstB.push(report) }));
    void harness.installer.install(ios("28.0", { onProgress: (report) => behind.push(report) }));
    await flush();

    // The first report is the install's start, before the driver's own percentage.
    expect(firstA).toEqual([{ stage: "downloading" }, { percent: 40, stage: "downloading" }]);
    expect(firstB).toEqual([{ stage: "downloading" }, { percent: 40, stage: "downloading" }]);
    expect(behind).toEqual([{ stage: "waiting" }]);
  });

  it("tells a call that its install started, with no percent, before the driver reports anything, and a call behind it hears the same when its own turn comes", async () => {
    const harness = await createHarness({
      drivers: (clock) => [new FakeDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    harness.ios.holdInstalls();
    const first: ComponentInstallerProgress[] = [];
    const behind: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => first.push(report) }));
    void harness.installer.install(ios("28.0", { onProgress: (report) => behind.push(report) }));
    await flush();

    // The driver is holding and has reported nothing: the start report is the installer's own.
    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(first).toEqual([{ stage: "downloading" }]);
    expect(behind).toEqual([{ stage: "waiting" }]);

    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);
    expect(behind).toEqual([{ stage: "waiting" }, { stage: "downloading" }]);
  });

  it("tells a call that joins a running install its latest report at once, and only that one", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          installProgress: [12, 41],
          platform: "ios",
        }),
      ],
    });
    harness.ios.holdInstalls();
    const early: ComponentInstallerProgress[] = [];
    const joiner: ComponentInstallerProgress[] = [];

    void harness.installer.install(ios("27.0", { onProgress: (report) => early.push(report) }));
    await flush();
    expect(early).toEqual([
      { stage: "downloading" },
      { percent: 12, stage: "downloading" },
      { percent: 41, stage: "downloading" },
    ]);

    void harness.installer.install(ios("27.0", { onProgress: (report) => joiner.push(report) }));
    // Synchronously, before anything else runs: the latest report, and only that one.
    expect(joiner).toEqual([{ percent: 41, stage: "downloading" }]);
    expect(early).toHaveLength(3);
  });

  it("tells its calls a driver's percentage clamped to 0..100, and one that is not a number as no percent", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          installProgress: [Number.NaN, -5, 150, 41.7],
          platform: "ios",
        }),
      ],
    });
    const heard: ComponentInstallerProgress[] = [];

    await harness.installer.install(ios("27.0", { onProgress: (report) => heard.push(report) }));

    expect(heard).toEqual([
      { stage: "downloading" },
      { stage: "downloading" },
      { percent: 0, stage: "downloading" },
      { percent: 100, stage: "downloading" },
      { percent: 41.7, stage: "downloading" },
      // The install succeeded with its last report below 100.
      { percent: 100, stage: "downloading" },
    ]);
  });

  describe("final report of a successful install", () => {
    /**
     * Everything one call hears, in order, with `settled: <outcome>` or `failed` appended when
     * its promise settles: the driver of iOS reports `installProgress`, and `failAfterProgress`
     * makes it throw once it has reported.
     */
    async function heardUntilSettled(
      component: string,
      installProgress: readonly number[],
      driverOptions: { readonly availableOsVersions?: readonly string[] } = {},
      failAfterProgress = false,
    ): Promise<unknown[]> {
      class FailingDriver extends FakeDriver {
        override async installComponent(
          installed: string,
          options: Parameters<FakeDriver["installComponent"]>[1],
        ): ReturnType<FakeDriver["installComponent"]> {
          for (const percent of installProgress)
            options.onProgress({ percent, stage: "downloading" });
          throw new DriverCrashError(`installing ${installed} failed`);
        }
      }
      const Driver = failAfterProgress ? FailingDriver : FakeDriver;
      const harness = await createHarness({
        drivers: (clock) => [
          new Driver({
            availableOsVersions: driverOptions.availableOsVersions ?? [],
            clock,
            installProgress,
            platform: "ios",
          }),
        ],
      });
      const heard: unknown[] = [];
      await harness.installer
        .install(ios(component, { onProgress: (report) => heard.push(report) }))
        .then(
          (outcome) => heard.push(`settled: ${outcome.outcome}`),
          () => heard.push("failed"),
        );
      return heard;
    }

    it.each([
      {
        reported: [12, 99.3],
        heard: [
          { stage: "downloading" },
          { percent: 12, stage: "downloading" },
          { percent: 99.3, stage: "downloading" },
          { percent: 100, stage: "downloading" },
          "settled: installed",
        ],
      },
      {
        reported: [],
        heard: [
          { stage: "downloading" },
          { percent: 100, stage: "downloading" },
          "settled: installed",
        ],
      },
      {
        reported: [50, 100],
        heard: [
          { stage: "downloading" },
          { percent: 50, stage: "downloading" },
          { percent: 100, stage: "downloading" },
          "settled: installed",
        ],
      },
    ])(
      "ends with exactly one 100 before it settles as installed, whatever the driver reported ($reported)",
      async ({ reported, heard }) => {
        await expect(heardUntilSettled("27.0", reported)).resolves.toEqual(heard);
      },
    );

    it("reports no final 100 for a failed install", async () => {
      await expect(heardUntilSettled("27.0", [40], {}, true)).resolves.toEqual([
        { stage: "downloading" },
        { percent: 40, stage: "downloading" },
        "failed",
      ]);
    });

    it("reports no final 100 for an install that ends already-installed", async () => {
      // `latest` is never found before the install runs; the driver then finds 26.5 there.
      await expect(
        heardUntilSettled("latest", [40], { availableOsVersions: ["26.5"] }),
      ).resolves.toEqual([
        { stage: "downloading" },
        { percent: 40, stage: "downloading" },
        "settled: already-installed",
      ]);
    });
  });
});
