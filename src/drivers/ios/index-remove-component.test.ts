import { afterEach, expect, describe, it, vi } from "vitest";
import { ComponentInUseError, ComponentNotOwnedError, DriverCrashError } from "../../core/index.js";
import { MemoryFilesystem, ScriptedProcessRunner, FakeClock } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { memorySourceDatabase, plantSource } from "./testing.js";
import {
  deviceRoot,
  simctl,
  driverData,
  waitForCalls,
  flushMicrotasks221,
  settledValue,
} from "./test-slim.js";
import {
  IOS_RUNTIME_ASSET_ROOT,
  RecordingLogger,
  SizedFilesystem,
  UNSCOPED_LEGACY_CALLS,
  assetInfoPlist,
  createDriver,
  defaultSetInvocation,
  defaultSetListed,
  image,
  imagesListed,
  listFixture,
  listInvocation,
  scopedRunners,
  scriptedListRunner,
  seedUdid,
  seededDatabase,
  sourcesSimctl,
  spec,
} from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver listComponents()", () => {
  describe("removeComponent()", () => {
    const target = image("26.4", "23E244", { sizeBytes: 7_000_000_000 });
    const other = image("18.4", "22E238");
    const receipt = { build: "23E244", image: "IMG-26.4-23E244" };
    const deleteInvocation = simctl("runtime", "delete", "IMG-26.4-23E244");
    const deleted = { match: deleteInvocation, result: { code: 0, stderr: "", stdout: "" } };
    const signal = () => new AbortController().signal;

    async function assetStore(
      builds: readonly (readonly [string, string])[],
    ): Promise<MemoryFilesystem> {
      return addAssets(new MemoryFilesystem(), builds);
    }

    async function addAssets(
      filesystem: MemoryFilesystem,
      builds: readonly (readonly [string, string])[],
    ): Promise<MemoryFilesystem> {
      for (const [index, [version, build]] of builds.entries()) {
        const bundle = `${IOS_RUNTIME_ASSET_ROOT}/bundle-${String(index)}.asset`;
        await filesystem.mkdirp(bundle);
        await filesystem.writeFileAtomic(`${bundle}/Info.plist`, assetInfoPlist(version, build));
      }
      return filesystem;
    }

    it("deletes the image the receipt names with simctl runtime delete and no --keep-asset, and reports no residue when it had no unused default-set device and its download is gone", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target, other]),
        defaultSetListed({ [other.runtime]: { unused: 4 } }),
        deleted,
        imagesListed([other]),
        imagesListed([other]),
        defaultSetListed({ [other.runtime]: { unused: 4 } }),
      ]);
      const filesystem = await assetStore([
        ["18.4", "22E238"],
        ["26.4", "23E200"],
      ]);
      const driver = await createDriver(runner, new FakeClock(), filesystem);

      await expect(driver.removeComponent(receipt, { signal: signal() })).resolves.toEqual({
        sizeBytes: 7_000_000_000,
      });
      expect(runner.calls[2]?.args).toEqual(deleteInvocation.args);
    });

    it("deletes the seeds made from the removed runtime and the rows of its settle before the runtime, logs one it cannot delete and goes on, and keeps the seeds of another runtime", async () => {
      const [goneSeed, stuckSeed, keptSeed, settlingSeed, retiredSeed] = [1, 2, 3, 4, 5].map(
        (n) => `00000000-0000-0000-0000-0000000002${String(n)}0`,
      ) as [string, string, string, string, string];
      const database = await memorySourceDatabase();
      const removed = {
        deviceTypeId: driverData.deviceTypeId,
        runtimeId: target.runtime,
      };
      plantSource(database, { ...removed, udid: goneSeed });
      plantSource(database, {
        ...removed,
        deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPad",
        udid: stuckSeed,
      });
      plantSource(database, {
        deviceTypeId: driverData.deviceTypeId,
        runtimeId: other.runtime,
        udid: keptSeed,
      });
      // why: a settle's row and the row of the quick seed it retires are `making` rows no make sweeps (ADR 0090).
      plantSource(database, {
        ...removed,
        settleOf: "settled",
        state: "making",
        udid: settlingSeed,
      });
      plantSource(database, {
        ...removed,
        settleOf: "settling",
        state: "making",
        udid: retiredSeed,
      });
      const runner = new ScriptedProcessRunner([
        imagesListed([target, other]),
        defaultSetListed({}),
        { match: sourcesSimctl("shutdown", goneSeed) },
        { match: sourcesSimctl("delete", goneSeed) },
        { match: sourcesSimctl("shutdown", stuckSeed) },
        {
          match: sourcesSimctl("delete", stuckSeed),
          result: { code: 1, stderr: "busy", stdout: "" },
        },
        { match: sourcesSimctl("shutdown", settlingSeed) },
        { match: sourcesSimctl("delete", settlingSeed) },
        { match: sourcesSimctl("shutdown", retiredSeed) },
        { match: sourcesSimctl("delete", retiredSeed) },
        deleted,
        imagesListed([other]),
        imagesListed([other]),
        defaultSetListed({}),
      ]);
      const logger = new RecordingLogger();
      const driver = await createDriver(
        runner,
        new FakeClock(),
        await assetStore([]),
        database,
        logger,
      );

      await driver.removeComponent(receipt, { signal: signal() });

      expect(runner.calls.map((call) => [call.args[3], call.args[4]])).toEqual(
        expect.arrayContaining([
          ["shutdown", goneSeed],
          ["delete", goneSeed],
          ["delete", stuckSeed],
          ["delete", settlingSeed],
          ["delete", retiredSeed],
          ["runtime", "delete"],
        ]),
      );
      expect(runner.calls.some((call) => call.args.includes(keptSeed))).toBe(false);
      expect(
        runner.calls.findIndex((call) => call.args[3] === "runtime" && call.args[4] === "delete"),
      ).toBeGreaterThan(runner.calls.findIndex((call) => call.args[4] === retiredSeed));
      expect(logger.warnings).toEqual([
        expect.stringContaining(
          `could not remove seed ${stuckSeed} of removed runtime ${target.runtime}:`,
        ),
      ]);
      expect(database.prepare("SELECT udid FROM ios_source_data ORDER BY udid").all()).toEqual([
        { udid: stuckSeed },
        { udid: keptSeed },
      ]);
    });

    it("starts the five-minute deletion budget after the seeds are deleted, so a seed held by a late clone does not use it up", async () => {
      const live = image("26.5", "23F77");
      const runtimeDelete = simctl("runtime", "delete", live.id);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { hangs: true, match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot) },
        imagesListed([live]),
        defaultSetListed({}),
        { match: sourcesSimctl("shutdown", seedUdid) },
        { match: sourcesSimctl("delete", seedUdid) },
        { match: runtimeDelete, result: { code: 0, stderr: "", stdout: "" } },
        imagesListed([live], "Deleting"),
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({}),
      ]);
      const clock = new FakeClock();
      const driver = await createDriver(
        runner,
        clock,
        await assetStore([]),
        await seededDatabase(),
      );
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
      const provision = driver.provision(spec).catch((error: unknown) => error);
      await waitForCalls(runner, 2);
      clock.advance(30_000);
      await provision;

      const removal = driver
        .removeComponent({ build: live.build, image: live.id }, { signal: signal() })
        .catch((caught: unknown) => caught);
      await flushMicrotasks221();
      clock.advance(300_000);
      const outcome = promiseState(removal);
      for (let step = 0; step < 10 && outcome.state === "pending"; step += 1) {
        await flushMicrotasks221();
        clock.advance(1_000);
      }

      expect(await removal).toEqual({ sizeBytes: 1_000 });
      expect(runner.calls.map((call) => call.args)).toContainEqual(runtimeDelete.args);
    });

    it("reports residue naming Xcode's Settings -> Platforms when the build's download is still in the asset store", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({}),
      ]);
      const filesystem = await assetStore([["26.4", "23E244"]]);
      const driver = await createDriver(runner, new FakeClock(), filesystem);

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal.residue).toContain("26.4 (23E244)");
      expect(removal.residue).toContain(IOS_RUNTIME_ASSET_ROOT);
      expect(removal.residue).toContain("Xcode's Settings -> Platforms");
      await expect(filesystem.exists(`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset`)).resolves.toBe(
        true,
      );
    });

    it("states the measured size of the download in residue, 8.5 GiB for an asset of 8,917,036 KiB", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({}),
      ]);
      // why: The iOS 18.6 download measured on a real machine.
      const filesystem = new SizedFilesystem(
        new Map([[`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset`, 8_917_036 * 1024]]),
      );
      await addAssets(filesystem, [["26.4", "23E244"]]);
      const driver = await createDriver(runner, new FakeClock(), filesystem);

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal.residue).toContain("its download (8.5 GiB) is still in");
    });

    it("states the same measured size in the doctor advisory as in the residue of the removal", async () => {
      const filesystem = new SizedFilesystem(
        new Map([[`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset`, 8_917_036 * 1024]]),
      );
      await addAssets(filesystem, [["26.4", "23E244"]]);
      const remover = await createDriver(
        new ScriptedProcessRunner([
          imagesListed([target]),
          defaultSetListed({}),
          deleted,
          imagesListed([]),
          imagesListed([]),
          defaultSetListed({}),
        ]),
        new FakeClock(),
        filesystem,
      );
      const residue = (await remover.removeComponent(receipt, { signal: signal() })).residue;
      const doctor = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);
      const advisory = (await doctor.advisories()).find(
        (candidate) => candidate.code === "runtime-cache-unreclaimable",
      );

      const sizeIn = (text: string | undefined) => /its download \(([^)]+)\)/.exec(text ?? "")?.[1];
      expect(sizeIn(residue)).toBe("8.5 GiB");
      expect(sizeIn(advisory?.message)).toBe(sizeIn(residue));
    });

    it("states the total size of two downloads the removed build leaves, as downloads of one runtime", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({}),
      ]);
      const filesystem = new SizedFilesystem(
        new Map([
          [`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset`, 8_917_036 * 1024],
          [`${IOS_RUNTIME_ASSET_ROOT}/bundle-1.asset`, 8_916_744 * 1024],
        ]),
      );
      await addAssets(filesystem, [
        ["26.4", "23E244"],
        ["26.4", "23E244"],
      ]);
      const driver = await createDriver(runner, new FakeClock(), filesystem);

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal.residue).toContain(
        "iOS 26.4 (23E244) is no longer installed, but its downloads (17.0 GiB in all) are " +
          "still in",
      );
      expect(removal.residue).toContain("does not reclaim them");
    });

    it("states no size in residue when the download's size cannot be read", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({}),
      ]);
      const filesystem = await assetStore([["26.4", "23E244"]]);
      await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset/AssetData`);
      filesystem.defineFailure(`${IOS_RUNTIME_ASSET_ROOT}/bundle-0.asset/AssetData`, "EACCES");
      const driver = await createDriver(runner, new FakeClock(), filesystem);

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal.residue).toContain("its download is still in");
      expect(removal.residue).not.toContain("GiB");
    });

    it("removes the runtime when its only default-set devices were never used (#241)", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({ [target.runtime]: { unused: 11 } }),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({ [target.runtime]: { unused: 11 } }),
      ]);
      const driver = await createDriver(runner, new FakeClock(), await assetStore([]));

      await expect(driver.removeComponent(receipt, { signal: signal() })).resolves.toMatchObject({
        sizeBytes: 7_000_000_000,
      });
      expect(runner.calls[2]?.args).toEqual(deleteInvocation.args);
    });

    it.each([
      [
        3,
        "3 never-used simulators in the default device set are now unavailable; Simlock does " +
          "not delete simulators there -- `xcrun simctl delete unavailable` clears them",
      ],
      [
        1,
        "1 never-used simulator in the default device set is now unavailable; Simlock does " +
          "not delete simulators there -- `xcrun simctl delete unavailable` clears them",
      ],
    ])(
      "reports %s unused default-set devices as unavailable in residue, naming xcrun simctl delete unavailable, in the singular for one (#241)",
      async (unused, residue) => {
        const runner = new ScriptedProcessRunner([
          imagesListed([target]),
          defaultSetListed({ [target.runtime]: { unused } }),
          deleted,
          imagesListed([]),
          imagesListed([]),
          defaultSetListed({ [target.runtime]: { unused } }),
        ]);
        const driver = await createDriver(runner, new FakeClock(), await assetStore([]));

        const removal = await driver.removeComponent(receipt, { signal: signal() });

        expect(removal.residue).toBe(residue);
      },
    );

    it("carries both the unavailable devices and the download left in the asset store in residue (#241)", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({ [target.runtime]: { unused: 2 } }),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({ [target.runtime]: { unused: 2 } }),
      ]);
      const driver = await createDriver(
        runner,
        new FakeClock(),
        await assetStore([["26.4", "23E244"]]),
      );

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal.residue).toMatch(
        /^2 never-used simulators .*`xcrun simctl delete unavailable` clears them\. iOS 26\.4 \(23E244\) is no longer installed, but its download .*Xcode's Settings -> Platforms to get the space back$/,
      );
    });

    it("reports no unavailable simulators when another installed build of the same runtime stays behind (#241)", async () => {
      // why: Two builds of iOS 26.4 share one runtime identifier, so its simulators keep working
      // on the build that stays.
      const sibling = image("26.4", "23E200", { id: "IMG-26.4-23E200" });
      const runner = new ScriptedProcessRunner([
        imagesListed([target, sibling]),
        defaultSetListed({ [target.runtime]: { unused: 3 } }),
        deleted,
        imagesListed([sibling]),
        imagesListed([sibling]),
        defaultSetListed({ [target.runtime]: { unused: 3 } }),
      ]);
      const driver = await createDriver(runner, new FakeClock(), await assetStore([]));

      const removal = await driver.removeComponent(receipt, { signal: signal() });

      expect(removal).toEqual({ sizeBytes: 7_000_000_000 });
    });

    it("runs no simctl command that writes to the default device set: its only unscoped call is the device list (#241)", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({ [target.runtime]: { unused: 11 } }),
        deleted,
        imagesListed([]),
        imagesListed([]),
        defaultSetListed({ [target.runtime]: { unused: 11 } }),
      ]);
      const driver = await createDriver(runner, new FakeClock(), await assetStore([]));

      await driver.removeComponent(receipt, { signal: signal() });

      // why: Every call that names no `--set` addresses the default set; each must be the read.
      const unscoped = runner.calls.filter(
        (call) => call.command === "xcrun" && !call.args.includes("--set"),
      );
      expect(unscoped.map((call) => call.args)).toEqual([
        defaultSetInvocation.args,
        defaultSetInvocation.args,
      ]);
      expect(runner.calls).toHaveLength(6);
    });

    it("reports the same foreign-device count in listComponents and in removeComponent's refusal for the same default set (#241)", async () => {
      const set = defaultSetListed({ [target.runtime]: { unused: 9, used: 2 } });
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        set,
        imagesListed([target]),
        set,
      ]);
      const driver = await createDriver(runner);

      const [listed] = await driver.listComponents();
      const error = await driver
        .removeComponent(receipt, { signal: signal() })
        .catch((caught: unknown) => caught);

      expect(listed?.foreignDevices).toBe(2);
      expect(error).toBeInstanceOf(ComponentInUseError);
      expect(error).toMatchObject({ foreignDevices: listed?.foreignDevices });
    });

    it("fails with simctl's own error when runtime delete exits non-zero", async () => {
      // why: No listing after the failure: the scripted runner fails any call it was not given.
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        {
          match: deleteInvocation,
          result: { code: 1, stderr: "Unable to delete runtime: in use", stdout: "" },
        },
      ]);
      const driver = await createDriver(runner);

      await expect(driver.removeComponent(receipt, { signal: signal() })).rejects.toThrow(
        "Unable to delete runtime: in use",
      );
      expect(runner.calls).toHaveLength(3);
    });

    it("refuses with ComponentInUseError when one default-set device of the runtime has lastUsedAt, and deletes nothing", async () => {
      // why: The scripted runner fails any call it was not given, so a delete would fail this test.
      // Ten never-used devices beside the used one: only the used one counts.
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({ [target.runtime]: { unused: 10, used: 1 } }),
      ]);
      const driver = await createDriver(runner);

      const error = await driver
        .removeComponent(receipt, { signal: signal() })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ComponentInUseError);
      expect(error).toMatchObject({ foreignDevices: 1 });
      expect(runner.calls).toHaveLength(2);
    });

    it("refuses with ComponentNotOwnedError when no listed image has the receipt, and deletes nothing", async () => {
      const runner = new ScriptedProcessRunner([imagesListed([target]), defaultSetListed({})]);
      const driver = await createDriver(runner);

      await expect(
        driver.removeComponent({ build: "23E244", image: "IMG-OTHER" }, { signal: signal() }),
      ).rejects.toBeInstanceOf(ComponentNotOwnedError);
      expect(runner.calls).toHaveLength(2);
    });

    it("fails when the image is still listed after simctl answered", async () => {
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        deleted,
        imagesListed([target]),
        imagesListed([target]),
        defaultSetListed({}),
      ]);
      const driver = await createDriver(runner);

      // why: The clock never moves, so a removal that waited would never settle.
      const error = await settledValue(
        driver.removeComponent(receipt, { signal: signal() }).catch((caught: unknown) => caught),
      );

      expect(error).toBeInstanceOf(DriverCrashError);
      expect(error).toMatchObject({ message: "ios 26.4 is still installed after it was removed" });
      expect(runner.calls).toHaveLength(6);
    });

    it("answers the removal with its size and residue when simctl runtime list shows the image as Deleting after simctl runtime delete returns and drops it seconds later (#259)", async () => {
      // why: As seen on Xcode 26.4.1: `simctl runtime delete` exits while `simctl runtime list`
      // still lists the image, in state `Deleting`, for about eight seconds. The runner answers
      // by the fake clock rather than by call order, so it does not dictate how a fix waits.
      const clock = new FakeClock();
      const deletingForMs = 8_000;
      const runner = new ClockedSimctl259(clock, deletingForMs, {
        defaultSet: defaultSetListed({ [target.runtime]: { unused: 2 } }),
        deleted,
        gone: imagesListed([]),
        ready: imagesListed([target]),
        deleting: imagesListed([target], "Deleting"),
      });
      const driver = await createDriver(runner, clock, await assetStore([]));

      let settled = false;
      const removal = driver
        .removeComponent(receipt, { signal: signal() })
        .catch((caught: unknown) => caught)
        .finally(() => {
          settled = true;
        });
      // why: Lets time pass in one-second steps, well inside the five-minute removal budget.
      for (let second = 0; second < 30 && !settled; second += 1) {
        await flushMicrotasks221();
        clock.advance(1_000);
      }

      expect(await settledValue(removal)).toEqual({
        residue:
          "2 never-used simulators in the default device set are now unavailable; Simlock does " +
          "not delete simulators there -- `xcrun simctl delete unavailable` clears them",
        sizeBytes: 7_000_000_000,
      });
      expect(runner.deletes).toBe(1);
    });

    it("fails with DriverCrashError five minutes after simctl runtime delete started, not after it answered, when simctl runtime list keeps showing the image as Deleting (#259)", async () => {
      // why: The delete itself takes two minutes, so a budget restarted when it answers would end
      // two minutes later than one measured from its start.
      const clock = new FakeClock();
      const runner = new ClockedSimctl259(
        clock,
        Number.POSITIVE_INFINITY,
        {
          defaultSet: defaultSetListed({}),
          deleted,
          gone: imagesListed([]),
          ready: imagesListed([target]),
          deleting: imagesListed([target], "Deleting"),
        },
        // why: Half a second off the one-second polls, so the last pause must be cut short.
        120_500,
      );
      const driver = await createDriver(runner, clock, await assetStore([]));

      let settledAt: number | undefined;
      const removal = driver
        .removeComponent(receipt, { signal: signal() })
        .catch((caught: unknown) => caught)
        .finally(() => {
          settledAt = clock.now();
        });
      // why: Half-second steps land on the deadline itself, so the time it fails at is exact.
      for (let step = 0; step < 1_200 && settledAt === undefined; step += 1) {
        await flushMicrotasks221();
        clock.advance(500);
      }

      const error = await settledValue(removal);
      expect(error).toBeInstanceOf(DriverCrashError);
      expect(error).toMatchObject({
        message: "ios 26.4 was still being deleted 300000ms after its removal started",
      });
      expect(settledAt).toBe((runner.deleteStartedAt ?? Number.NaN) + 300_000);
      expect(clock.pendingTimerCount).toBe(0);
    });

    it("fails with DriverCrashError as soon as the signal fires while simctl runtime list shows the image as Deleting, and lists no more (#259)", async () => {
      const clock = new FakeClock();
      const runner = new ClockedSimctl259(clock, Number.POSITIVE_INFINITY, {
        defaultSet: defaultSetListed({}),
        deleted,
        gone: imagesListed([]),
        ready: imagesListed([target]),
        deleting: imagesListed([target], "Deleting"),
      });
      const driver = await createDriver(runner, clock, await assetStore([]));
      const controller = new AbortController();

      const removal = driver
        .removeComponent(receipt, { signal: controller.signal })
        .catch((caught: unknown) => caught);
      await vi.waitFor(() => expect(runner.listsAfterDelete).toBe(1));
      await flushMicrotasks221();
      // why: The clock never moves: only the signal can end the wait.
      controller.abort();

      const error = await settledValue(removal);
      expect(error).toBeInstanceOf(DriverCrashError);
      expect(error).toMatchObject({
        message: "The removal of ios 26.4 was ended while it was still being deleted",
      });
      expect(runner.listsAfterDelete).toBe(1);
      expect(clock.pendingTimerCount).toBe(0);
    });

    it("lists the images again every second while simctl runtime list shows the image as Deleting, and leaves no abort listener behind (#259)", async () => {
      const clock = new FakeClock();
      const runner = new ClockedSimctl259(clock, 3_500, {
        defaultSet: defaultSetListed({}),
        deleted,
        gone: imagesListed([]),
        ready: imagesListed([target]),
        deleting: imagesListed([target], "Deleting"),
      });
      const driver = await createDriver(runner, clock, await assetStore([]));
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");

      const removal = driver.removeComponent(receipt, { signal: controller.signal });
      await vi.waitFor(() => expect(runner.listsAfterDelete).toBe(1));
      for (const expected of [2, 3, 4]) {
        await flushMicrotasks221();
        clock.advance(999);
        await flushMicrotasks221();
        expect(runner.listsAfterDelete).toBe(expected - 1);
        clock.advance(1);
        await vi.waitFor(() => expect(runner.listsAfterDelete).toBe(expected));
      }
      // why: Gone at 3.5 s: the listing at 4 s ends the wait.
      await flushMicrotasks221();
      clock.advance(1_000);
      await expect(removal).resolves.toEqual({ sizeBytes: 7_000_000_000 });
      expect(added.mock.calls.length).toBeGreaterThan(1);
      expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
        expect.arrayContaining(added.mock.calls.map(([, listener]) => listener)),
      );
    });

    it.each(["deleting", "DELETING"])(
      "waits while simctl runtime list shows the image in state %s, the state compared ignoring case (#259)",
      async (state) => {
        const clock = new FakeClock();
        const runner = new ClockedSimctl259(clock, 2_000, {
          defaultSet: defaultSetListed({}),
          deleted,
          gone: imagesListed([]),
          ready: imagesListed([target]),
          deleting: imagesListed([target], state),
        });
        const driver = await createDriver(runner, clock, await assetStore([]));

        let settled = false;
        const removal = driver
          .removeComponent(receipt, { signal: signal() })
          .catch((caught: unknown) => caught)
          .finally(() => {
            settled = true;
          });
        for (let second = 0; second < 30 && !settled; second += 1) {
          await flushMicrotasks221();
          clock.advance(1_000);
        }

        expect(await settledValue(removal)).toEqual({ sizeBytes: 7_000_000_000 });
      },
    );

    it("fails with DriverCrashError when the signal fires while simctl runtime list is answering that the image is Deleting, and lists no more (#259)", async () => {
      const clock = new FakeClock();
      const controller = new AbortController();
      const runner = new ClockedSimctl259(
        clock,
        Number.POSITIVE_INFINITY,
        {
          defaultSet: defaultSetListed({}),
          deleted,
          gone: imagesListed([]),
          ready: imagesListed([target]),
          deleting: imagesListed([target], "Deleting"),
        },
        0,
        () => {
          controller.abort();
        },
      );
      const driver = await createDriver(runner, clock, await assetStore([]));

      // why: The clock never moves: only the signal, already fired when the pause starts, ends it.
      const error = await settledValue(
        driver
          .removeComponent(receipt, { signal: controller.signal })
          .catch((caught: unknown) => caught),
      );

      expect(error).toBeInstanceOf(DriverCrashError);
      expect(error).toMatchObject({
        message: "The removal of ios 26.4 was ended while it was still being deleted",
      });
      expect(runner.listsAfterDelete).toBe(1);
      expect(clock.pendingTimerCount).toBe(0);
    });

    it("ends simctl runtime delete after five minutes, SIGTERM then SIGKILL, and answers only once it has exited", async () => {
      // why: Ignores SIGTERM: only the SIGKILL ten seconds later ends it.
      const stubborn = { hangs: true, ignoresSigterm: true, match: deleteInvocation };
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        stubborn,
      ]);
      const driver = await createDriver(runner, clock);
      let settled = false;
      const removal = driver
        .removeComponent(receipt, { signal: signal() })
        .catch((caught: unknown) => caught)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(runner.calls).toHaveLength(3));

      clock.advance(5 * 60_000);
      await flushMicrotasks221();
      expect(settled).toBe(false);
      clock.advance(10_000);

      expect(await settledValue(removal)).toMatchObject({
        message: expect.stringMatching(/timed out after 300000ms/),
      });
    });

    it("ends simctl runtime delete when its signal fires, and starts none when it already has", async () => {
      const abort = new AbortController();
      const runner = new ScriptedProcessRunner([
        imagesListed([target]),
        defaultSetListed({}),
        { hangs: true, match: deleteInvocation },
      ]);
      const driver = await createDriver(runner);
      const aborted = driver
        .removeComponent(receipt, { signal: abort.signal })
        .catch((caught: unknown) => caught);
      await vi.waitFor(() => expect(runner.calls).toHaveLength(3));
      abort.abort();
      expect(await settledValue(aborted)).toMatchObject({
        message: expect.stringMatching(/was ended before it finished/),
      });

      // why: The scripted runner fails any call it was not given, so a delete would fail this.
      const lateRunner = new ScriptedProcessRunner([imagesListed([target]), defaultSetListed({})]);
      const lateDriver = await createDriver(lateRunner);
      await expect(
        lateDriver.removeComponent(receipt, { signal: AbortSignal.abort() }),
      ).rejects.toThrow(/was ended before it finished/);
      expect(lateRunner.calls).toHaveLength(2);
    });
  });
});

type ScriptedStep259 = ConstructorParameters<typeof ScriptedProcessRunner>[0][number];

class ClockedSimctl259 extends ScriptedProcessRunner {
  deletes = 0;
  deleteStartedAt: number | undefined;
  listsAfterDelete = 0;
  #deletedAt: number | undefined;

  constructor(
    private readonly clock: FakeClock,
    private readonly deletingForMs: number,
    private readonly steps: {
      readonly ready: ScriptedStep259;
      readonly deleting: ScriptedStep259;
      readonly gone: ScriptedStep259;
      readonly deleted: ScriptedStep259;
      readonly defaultSet: ScriptedStep259;
    },
    private readonly deleteTakesMs = 0,
    private readonly onListAfterDelete: () => void = () => undefined,
  ) {
    super([]);
  }

  override spawn(...call: Parameters<ScriptedProcessRunner["spawn"]>) {
    const [command, args] = call;
    const argv = args.join(" ");
    let step: ScriptedStep259;
    if (argv.endsWith("runtime delete IMG-26.4-23E244")) {
      this.deletes += 1;
      this.deleteStartedAt = this.clock.now();
      this.clock.advance(this.deleteTakesMs);
      this.#deletedAt = this.clock.now();
      step = this.steps.deleted;
    } else if (argv.endsWith("runtime list -j")) {
      if (this.#deletedAt !== undefined) {
        this.listsAfterDelete += 1;
        this.onListAfterDelete();
      }
      step =
        this.#deletedAt === undefined
          ? this.steps.ready
          : this.clock.now() - this.#deletedAt < this.deletingForMs
            ? this.steps.deleting
            : this.steps.gone;
    } else if (argv === "simctl list -j devices") {
      step = this.steps.defaultSet;
    } else {
      throw new Error(`Unexpected process invocation: ${command} ${argv}`);
    }
    const handle = new ScriptedProcessRunner([step]).spawn(...call);
    this.calls.push({ args: [...args], command, options: call[2] ?? {} });
    return handle;
  }
}
