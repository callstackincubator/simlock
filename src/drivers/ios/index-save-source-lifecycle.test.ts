import { afterEach, expect, describe, it } from "vitest";
import { BootTimeoutError, DriverCrashError } from "../../core/index.js";
import { MemoryFilesystem, ScriptedProcessRunner, FakeClock } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceRoot,
  driverData,
  simctl,
  plantManagedDevice,
  overridesFolder,
  overridesPath,
  recordPath,
  overridesPlist,
  FaultyFilesystem,
  instanceId,
  overridesRoot,
  flushMicrotasks221,
  simctlArgs,
  waitForCalls,
} from "./test-slim.js";
import {
  RecordingLogger,
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  deviceListResponse,
  launchServicesFiles,
  legacyUdid,
  listDevicesInvocation,
  listFixture,
  listInvocation,
  plantLaunchServices,
  prepareFull,
  scopedRunners,
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

describe("IosSimctlDriver", () => {
  describe("saveSource", () => {
    const cloneUdid = "00000000-0000-0000-0000-0000000000bb";
    const baselineName = "simlock-baseline-device-1";
    const sourcesSet = `${deviceRoot}/sources`;
    const device = {
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData: { ...driverData, lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"] },
      physical: false,
    } as const;
    const cloneInvocation = simctl("clone", driverData.udid, baselineName, sourcesSet);

    it("keeps a shut-down copy of the device in the sources set as a ready baseline source with its disabled.plist, and a failing clone keeps no row", async () => {
      const database = await memorySourceDatabase();
      const rowsAtShutdown: unknown[] = [];
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await filesystem.mkdirp(overridesFolder(driverData.udid));
      await filesystem.writeFileAtomic(
        overridesPath(driverData.udid),
        overridesPlist({ "a.b": true }),
      );
      await filesystem.mkdirp(`${sourcesSet}/${cloneUdid}/data`);
      await filesystem.writeFileAtomic(`${sourcesSet}/${cloneUdid}/data/state`, "12345");
      await plantLaunchServices(filesystem, `${sourcesSet}/${cloneUdid}`);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: simctl("shutdown", driverData.udid),
          onSpawn: () => {
            rowsAtShutdown.push(
              ...database.prepare("SELECT kind, state, udid FROM ios_source_data").all(),
            );
          },
        },
        { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${cloneUdid}\n` } },
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      ]);
      const driver = await createDriver(runner, new FakeClock(), filesystem, database);

      await expect(driver.saveSource(device)).resolves.toEqual({
        sizeBytes: 5,
        sourceId: "device-1",
      });

      expect(rowsAtShutdown, "the source's row is making before the device shuts down").toEqual([
        { kind: "baseline", state: "making", udid: null },
      ]);
      expect(runner.calls).toEqual([
        { ...listInvocation, options: { timeoutMs: 30_000 } },
        { ...simctl("shutdown", driverData.udid), options: { timeoutMs: 30_000 } },
        { ...cloneInvocation, options: { timeoutMs: 330_000 } },
      ]);
      expect(await filesystem.readFile(overridesPath(cloneUdid))).toBe(
        overridesPlist({ "a.b": true }),
      );
      expect(await launchServicesFiles(filesystem, `${sourcesSet}/${cloneUdid}`)).toEqual([
        "com.apple.LaunchServices.unregisteredtypes-501.db",
      ]);
      await expect(driver.listSources()).resolves.toEqual([
        {
          id: "device-1",
          kind: "baseline",
          model: "iPhone 16",
          osVersion: "26.5",
          sizeBytes: 5,
        },
      ]);

      const failingRunner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { match: simctl("shutdown", driverData.udid) },
        {
          match: cloneInvocation,
          result: { code: 1, stderr: "No space left on device", stdout: "" },
        },
      ]);
      const emptyDatabase = await memorySourceDatabase();
      const failing = await createDriver(failingRunner, new FakeClock(), filesystem, emptyDatabase);
      await expect(failing.saveSource(device)).rejects.toMatchObject({
        message: expect.stringContaining("No space left on device"),
      });
      expect(emptyDatabase.prepare("SELECT source_id FROM ios_source_data").all()).toEqual([]);

      const stuckRunner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: simctl("shutdown", driverData.udid),
          result: { code: 1, stderr: "Unable to shut down device", stdout: "" },
        },
      ]);
      const stuckDatabase = await memorySourceDatabase();
      const stuck = await createDriver(stuckRunner, new FakeClock(), filesystem, stuckDatabase);
      await expect(stuck.saveSource(device)).rejects.toMatchObject({
        message: expect.stringContaining("Unable to shut down device"),
      });
      expect(stuckRunner.calls.map((call) => call.args[1])).not.toContain("clone");
      expect(stuckDatabase.prepare("SELECT source_id FROM ios_source_data").all()).toEqual([]);

      const lateRunner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { match: simctl("shutdown", driverData.udid) },
        { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${cloneUdid}\n` } },
        { match: sourcesSimctl("shutdown", cloneUdid) },
        { match: sourcesSimctl("delete", cloneUdid) },
      ]);
      const lateDatabase = await memorySourceDatabase();
      lateDatabase.exec(
        "CREATE TRIGGER refuse_update BEFORE UPDATE ON ios_source_data BEGIN SELECT RAISE(ABORT, 'source row locked'); END",
      );
      const late = await createDriver(lateRunner, new FakeClock(), filesystem, lateDatabase);
      await expect(late.saveSource(device)).rejects.toMatchObject({
        message: expect.stringContaining("source row locked"),
      });
      expect(
        lateRunner.calls.slice(3).map((call) => call.args.at(-2)),
        "the clone made before the failure is shut down and deleted from the sources set",
      ).toEqual(["shutdown", "delete"]);
      expect(lateDatabase.prepare("SELECT source_id FROM ios_source_data").all()).toEqual([]);
    });
  });

  it.each([
    {
      name: "copies the seed's disabled.plist and its record of named services to the new simulator",
      seedHas: true,
      failing: undefined,
    },
    { name: "copies nothing when the seed has none", seedHas: false, failing: undefined },
    {
      name: "logs a warning and goes on when the copy fails",
      seedHas: true,
      failing: "copyFile" as const,
    },
  ])("a provision $name", async ({ seedHas, failing }) => {
    const filesystem = new FaultyFilesystem();
    await plantManagedDevice(filesystem);
    if (seedHas) {
      await filesystem.mkdirp(overridesFolder(seedUdid));
      await filesystem.writeFileAtomic(overridesPath(seedUdid), overridesPlist({ "a.b": true }));
      await filesystem.writeFileAtomic(recordPath(seedUdid), '["a.b"]');
    }
    await plantLaunchServices(filesystem, `${deviceRoot}/${driverData.udid}`);
    filesystem.failing = failing;
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
    ]);
    const logger = new RecordingLogger();
    const driver = await IosSimctlDriver.create({
      database: await seededDatabase(),
      clock: new FakeClock(),
      driverConfig: { deviceRoot },
      filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId,
      launchdOverridesRoot: overridesRoot,
      logger,
      processRunner: runner,
      simlockHome: "/home/.simlock",
    });
    scopedRunners.push(runner);
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

    await expect(driver.provision(spec)).resolves.toMatchObject({ deviceId: driverData.udid });

    expect(
      await launchServicesFiles(filesystem, `${deviceRoot}/${driverData.udid}`),
      "a copy of a seed loses the LaunchServices database that names the seed's folder",
    ).toEqual(["com.apple.LaunchServices.unregisteredtypes-501.db"]);
    const copied = failing === undefined && seedHas;
    expect(await filesystem.exists(overridesPath(driverData.udid))).toBe(copied);
    expect(await filesystem.exists(recordPath(driverData.udid))).toBe(copied);
    if (copied) {
      expect(await filesystem.readFile(recordPath(driverData.udid))).toBe('["a.b"]');
      expect(await filesystem.readFile(overridesPath(driverData.udid))).toBe(
        overridesPlist({ "a.b": true }),
      );
    }
    expect(logger.warnings).toEqual(
      failing === undefined
        ? []
        : [
            `could not copy the launchd overrides of seed ${seedUdid} to ${driverData.udid}: disk full`,
          ],
    );
  });

  it("keeps no copy of a slim spec's mode in driver data", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      {
        match: listDevicesInvocation,
        result: { code: 0, stderr: "", stdout: deviceListResponse("Shutdown") },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    const driver = await createDriver(runner, new FakeClock(), filesystem, await seededDatabase());
    await driver.resolveSpec({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    await expect(driver.provision({ ...spec, mode: "slim" })).resolves.toEqual({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData: { ...driverData, lineage: [] },
    });
  });

  it("surfaces simctl failures with stderr", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: listInvocation,
        result: { code: 0, stderr: "", stdout: listFixture },
      },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 1, stderr: "Invalid runtime", stdout: "" },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), undefined, await seededDatabase());
    await driver.resolveSpec({
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    await expect(driver.provision(spec)).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Invalid runtime"),
        name: "DriverCrashError",
      }),
    );
  });

  it("boots then checks bootstatus and installer readiness with bounded commands", async () => {
    const runner = new ScriptedProcessRunner([
      { match: simctl("rename", driverData.udid, driverData.name) },
      { match: simctl("boot", driverData.udid) },
      { match: simctl("bootstatus", driverData.udid, "-b") },
      { match: simctl("listapps", driverData.udid) },
    ]);
    const driver = await createDriver(runner);

    await expect(
      driver.makeReady(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        prepareFull,
      ),
    ).resolves.toEqual({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
      // why: Slim mode is off, so this boot slimmed nothing: the device is full.
      mode: "full",
    });
    expect(runner.calls).toEqual([
      { ...simctl("rename", driverData.udid, driverData.name), options: { timeoutMs: 5_000 } },
      { ...simctl("boot", driverData.udid), options: { timeoutMs: 300_000 } },
      { ...simctl("bootstatus", driverData.udid, "-b"), options: { timeoutMs: 300_000 } },
      { ...simctl("listapps", driverData.udid), options: { timeoutMs: 30_000 } },
    ]);
  });

  it.each([false, true])(
    "keeps makeReady pending until an installer probe succeeds after a failure (hung: %s)",
    async (hangs) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { match: simctl("rename", driverData.udid, driverData.name) },
        { match: simctl("boot", driverData.udid) },
        { match: simctl("bootstatus", driverData.udid, "-b") },
        {
          match: simctl("listapps", driverData.udid),
          result: { code: 2, stderr: "installer starting", stdout: "" },
          hangs,
        },
        { match: simctl("listapps", driverData.udid) },
      ]);
      const driver = await createDriver(runner, clock);
      const ready = driver.makeReady(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        prepareFull,
      );
      const state = promiseState(ready);
      await flushMicrotasks221();
      expect(state.state).toBe("pending");
      expect(runner.calls.at(-1)?.args).toEqual(simctlArgs("listapps", driverData.udid));
      if (hangs) {
        clock.advance(30_000);
        await flushMicrotasks221();
        expect(state.state).toBe("pending");
      }
      clock.advance(1_000);
      await flushMicrotasks221();
      expect(state.state).toBe("fulfilled");
      expect((await ready).deviceId).toBe(driverData.udid);
    },
  );

  it.each([false, true])(
    "shares the bootstatus deadline with a %s-hanging installer probe and shuts down on expiry",
    async (hangs) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { match: simctl("rename", driverData.udid, driverData.name) },
        { match: simctl("boot", driverData.udid) },
        {
          match: simctl("bootstatus", driverData.udid, "-b"),
          onSpawn: () => clock.advance(299_500),
        },
        {
          match: simctl("listapps", driverData.udid),
          hangs,
          result: { code: 2, stderr: "installer starting", stdout: "" },
        },
        { match: simctl("shutdown", driverData.udid) },
      ]);
      const driver = await createDriver(runner, clock);
      const ready = driver.makeReady(
        { address: driverData.udid, deviceId: driverData.udid, driverData },
        prepareFull,
      );
      const state = promiseState(ready);
      await flushMicrotasks221();
      expect(state.state).toBe("pending");
      expect(runner.calls.at(-1)).toEqual({
        ...simctl("listapps", driverData.udid),
        options: { timeoutMs: 500 },
      });
      clock.advance(499);
      await flushMicrotasks221();
      expect(state.state).toBe("pending");
      clock.advance(1);
      await flushMicrotasks221();
      expect(state.state).toBe("rejected");
      await expect(ready).rejects.toBeInstanceOf(BootTimeoutError);
      expect(runner.calls.at(-1)?.args).toEqual(simctlArgs("shutdown", driverData.udid));
    },
  );

  it.each(["bootstatus", "listapps"])(
    "rejects readiness when a successful %s consumes the remaining budget",
    async (slowCommand) => {
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { match: simctl("rename", driverData.udid, driverData.name) },
        { match: simctl("boot", driverData.udid) },
        {
          match: simctl("bootstatus", driverData.udid, "-b"),
          onSpawn: () => {
            if (slowCommand === "bootstatus") clock.advance(300_000);
          },
        },
        ...(slowCommand === "listapps"
          ? [{ match: simctl("listapps", driverData.udid), onSpawn: () => clock.advance(300_000) }]
          : []),
        { match: simctl("shutdown", driverData.udid) },
      ]);
      const driver = await createDriver(runner, clock);
      await expect(
        driver.makeReady(
          { address: driverData.udid, deviceId: driverData.udid, driverData },
          prepareFull,
        ),
      ).rejects.toBeInstanceOf(BootTimeoutError);
      expect(runner.calls.map((call) => call.args)).toEqual([
        simctlArgs("rename", driverData.udid, driverData.name),
        simctlArgs("boot", driverData.udid),
        simctlArgs("bootstatus", driverData.udid, "-b"),
        ...(slowCommand === "listapps" ? [simctlArgs("listapps", driverData.udid)] : []),
        simctlArgs("shutdown", driverData.udid),
      ]);
    },
  );

  it("times out bootstatus and issues a best-effort shutdown", async () => {
    const clock = new FakeClock();
    const runner = new ScriptedProcessRunner([
      { match: simctl("rename", driverData.udid, driverData.name) },
      { match: simctl("boot", driverData.udid) },
      { hangs: true, match: simctl("bootstatus", driverData.udid, "-b") },
      { match: simctl("shutdown", driverData.udid) },
    ]);
    const driver = await createDriver(runner, clock);
    const ready = driver.makeReady(
      { address: driverData.udid, deviceId: driverData.udid, driverData },
      prepareFull,
    );
    // why: Handled up front so a failure below reports itself rather than surfacing as an
    // unhandled rejection in whichever test happens to run next.
    void ready.catch(() => undefined);

    await waitForCalls(runner, 3);
    clock.advance(300_000);

    await expect(ready).rejects.toBeInstanceOf(BootTimeoutError);
    expect(runner.calls.map((call) => call.args)).toEqual([
      simctlArgs("rename", driverData.udid, driverData.name),
      simctlArgs("boot", driverData.udid),
      simctlArgs("bootstatus", driverData.udid, "-b"),
      simctlArgs("shutdown", driverData.udid),
    ]);
  });

  it("throws virtual devices are not reclaimed for a simulator, from reclaim and reclaimStrategy", async () => {
    const runner = new ScriptedProcessRunner([]);
    const driver = await createDriver(runner);
    const simulator = { address: driverData.udid, deviceId: driverData.udid, driverData };

    await expect(driver.reclaim(simulator, { clean: "full" })).rejects.toThrow(
      "virtual devices are not reclaimed",
    );
    expect(() => driver.reclaimStrategy(simulator, { clean: "standard" })).toThrow(
      "virtual devices are not reclaimed",
    );
    expect(runner.calls).toEqual([]);
  });

  it("shuts down before deleting and uses benchmark estimates", async () => {
    const runner = new ScriptedProcessRunner([
      { match: simctl("shutdown", driverData.udid) },
      { match: simctl("delete", driverData.udid) },
    ]);
    const driver = await createDriver(runner);

    await driver.destroy({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData,
    });

    expect(runner.calls.map((call) => call.args)).toEqual([
      simctlArgs("shutdown", driverData.udid),
      simctlArgs("delete", driverData.udid),
    ]);
    expect(driver.estimate({ operation: "provision" }, spec)).toBe(500);
    expect(driver.estimate({ operation: "boot" }, spec)).toBe(60_000);
  });

  it.each([
    { name: "removal succeeds", method: "destroy" as const, failing: undefined, deleteCode: 0 },
    {
      name: "rm throws, which is logged and does not fail the destroy",
      method: "destroy" as const,
      failing: "rm" as const,
      deleteCode: 0,
    },
    {
      name: "simctl delete fails, so the folder is kept and the error thrown",
      method: "destroy" as const,
      failing: undefined,
      deleteCode: 1,
    },
    {
      name: "destroyLegacy removes it too",
      method: "destroyLegacy" as const,
      failing: undefined,
      deleteCode: 0,
    },
  ])(
    "removes the overrides folder of a destroyed simulator after simctl delete: $name",
    async ({ method, failing, deleteCode }) => {
      const udid = method === "destroy" ? driverData.udid : legacyUdid;
      const args = (verb: string) =>
        method === "destroy" ? simctlArgs(verb, udid) : ["simctl", verb, udid];
      const runner = new ScriptedProcessRunner([
        { match: { args: args("shutdown"), command: "xcrun" } },
        {
          match: { args: args("delete"), command: "xcrun" },
          result: { code: deleteCode, stderr: "no", stdout: "" },
        },
      ]);
      const filesystem = new FaultyFilesystem();
      await filesystem.mkdirp(overridesFolder(udid));
      await filesystem.writeFileAtomic(overridesPath(udid), "x");
      await filesystem.mkdirp(overridesFolder("other-udid"));
      filesystem.failing = failing;
      const logger = new RecordingLogger();
      scopedRunners.push(runner);
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        driverConfig: { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        launchdOverridesRoot: overridesRoot,
        logger,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });
      const device = { address: udid, deviceId: udid, driverData: { ...driverData, udid } };

      const destroyed = driver[method](device);

      if (deleteCode === 0) {
        await expect(destroyed).resolves.toBeUndefined();
      } else {
        await expect(destroyed).rejects.toBeInstanceOf(DriverCrashError);
      }
      const removed = deleteCode === 0 && failing === undefined;
      expect(await filesystem.exists(overridesFolder(udid))).toBe(!removed);
      expect(await filesystem.exists(overridesFolder("other-udid"))).toBe(true);
      expect(logger.warnings).toEqual(
        failing === undefined
          ? []
          : [`could not remove the launchd overrides folder of ${udid}: disk full`],
      );
    },
  );
});
