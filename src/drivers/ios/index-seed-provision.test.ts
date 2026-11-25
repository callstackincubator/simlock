import { join } from "node:path";
import { afterEach, expect, it, vi, describe } from "vitest";
import { DriverCrashError } from "../../core/index.js";
import {
  ScriptedProcessRunner,
  MemoryFilesystem,
  FakeClock,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessHandle,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  deviceRoot,
  sourcesSetPath,
  driverData,
  plantManagedDevice,
  waitForCalls,
  simctl,
  instanceId,
  unownedSourcesSet,
} from "./test-slim.js";
import {
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  listFixture,
  listInvocation,
  scopedRunners,
  plantSeedClone,
  seedUdid,
  seededDatabase,
  sourcesSimctl,
  spec,
  throwawaySeedSteps,
  throwawayUdid,
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
    expect([deviceRoot, sourcesSetPath]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver", () => {
  it("a provision that makes a new iOS seed boots the seed within ios.full.bootTimeoutMs", async () => {
    for (const { full, waitsMs } of [
      { full: undefined, waitsMs: 300_000 },
      { full: 400_000, waitsMs: 400_000 },
    ]) {
      const cloneInvocation = sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        ...throwawaySeedSteps(),
        { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` } },
      ]);
      const filesystem = new MemoryFilesystem();
      const driver = await createDriver(
        runner,
        new FakeClock(),
        filesystem,
        undefined,
        undefined,
        full,
      );
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);

      await driver.provision(spec);

      expect(
        runner.calls.find((call) => call.args.includes("bootstatus"))?.options,
        `key ${String(full)}`,
      ).toEqual({ timeoutMs: waitsMs });
    }
  });

  it("provisions a copy of the kind's seed, making the seed first when there is none", async () => {
    const copyUdid = "00000000-0000-0000-0000-000000000002";
    const database = await memorySourceDatabase();
    const rowsWhenCreated: unknown[] = [];
    const seedCreate = simctl(
      "create",
      "simlock-seed-device-1",
      driverData.deviceTypeId,
      driverData.runtimeId,
    );
    const cloneInvocation = sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot);
    const [create, ...afterCreate] = throwawaySeedSteps();
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        ...create,
        match: seedCreate,
        onSpawn: () => {
          rowsWhenCreated.push(
            ...database.prepare("SELECT state, udid FROM ios_source_data").all(),
          );
        },
      },
      ...afterCreate,
      { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` } },
      { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${copyUdid}\n` } },
    ]);
    const filesystem = new ModeRecordingFilesystem();
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);

    await expect(driver.provision(spec)).resolves.toEqual({
      address: driverData.udid,
      deviceId: driverData.udid,
      driverData: { ...driverData, lineage: [throwawayUdid.toUpperCase()] },
    });
    expect(
      rowsWhenCreated,
      "the seed's row is making, with no simulator yet, when create runs",
    ).toEqual([{ state: "making", udid: null }]);
    expect(
      filesystem.mkdirpModes.get(sourcesSetPath),
      "under deviceSet simlock the sources set is asked for private to the user",
    ).toBe(0o700);
    expect(runner.calls).toEqual([
      { ...listInvocation, options: { timeoutMs: 30_000 } },
      { ...seedCreate, options: { timeoutMs: 330_000 } },
      { ...simctl("boot", throwawayUdid), options: { timeoutMs: 300_000 } },
      { ...simctl("bootstatus", throwawayUdid, "-b"), options: { timeoutMs: 300_000 } },
      { ...simctl("listapps", throwawayUdid), options: { timeoutMs: 30_000 } },
      { ...simctl("shutdown", throwawayUdid), options: { timeoutMs: 30_000 } },
      {
        ...simctl("clone", throwawayUdid, "simlock-seed-device-1", sourcesSetPath),
        options: { timeoutMs: 330_000 },
      },
      { ...simctl("delete", throwawayUdid), options: { timeoutMs: 30_000 } },
      { ...cloneInvocation, options: { timeoutMs: 330_000 } },
    ]);

    await expect(driver.provision(spec)).resolves.toMatchObject({ deviceId: copyUdid });
    expect(runner.calls.slice(9)).toEqual([
      { ...cloneInvocation, options: { timeoutMs: 330_000 } },
    ]);
  });

  it("a clone that fails makes the provision throw and keeps the seed and its row", async () => {
    const database = await seededDatabase();
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 1, stderr: "No space left on device", stdout: "" },
      },
    ]);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);

    const error = await driver.provision(spec).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DriverCrashError);
    expect((error as Error).message).toContain("No space left on device");
    expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "clone"]);
    expect(database.prepare("SELECT udid, state FROM ios_source_data").all()).toEqual([
      { state: "ready", udid: seedUdid },
    ]);
  });

  it("two provisions at once make one seed, and the clones of one seed run one at a time", async () => {
    const copyUdid = "00000000-0000-0000-0000-000000000002";
    const cloneInvocation = sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot);
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      ...throwawaySeedSteps(),
      { hangs: true, match: cloneInvocation },
      { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${copyUdid}\n` } },
    ]);
    const filesystem = new MemoryFilesystem();
    const clock = new FakeClock();
    const driver = await createDriver(runner, clock, filesystem);
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
    const clones = (): number =>
      runner.calls.filter((call) => call.args[3] === "clone" && call.args[4] === seedUdid).length;

    const first = driver.provision(spec);
    const second = driver.provision(spec);
    const firstSettled = first.catch((caught: unknown) => caught);
    await waitForCalls(runner, 10);

    expect(runner.calls.filter((call) => call.args[3] === "create")).toHaveLength(1);
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    expect(clones()).toBe(1);

    clock.advance(30_000);

    expect(await firstSettled).toBeInstanceOf(DriverCrashError);
    await expect(second).resolves.toMatchObject({ deviceId: copyUdid });
    expect(clones()).toBe(2);
  });

  it.each([
    {
      call: "a provision's clone",
      act: (driver: IosSimctlDriver) => driver.provision(spec),
      seeded: true,
      steps: [
        { hangs: true, match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot) },
      ],
    },
    {
      call: "a seed's create",
      act: (driver: IosSimctlDriver) => driver.provision(spec),
      seeded: false,
      steps: [
        {
          hangs: true,
          match: simctl(
            "create",
            "simlock-seed-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ),
        },
      ],
    },
    {
      call: "a baseline's clone",
      act: (driver: IosSimctlDriver) =>
        driver.saveSource({
          address: driverData.udid,
          deviceId: driverData.udid,
          driverData,
          physical: false,
        }),
      seeded: false,
      steps: [
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { match: simctl("shutdown", driverData.udid) },
        {
          hangs: true,
          match: simctl("clone", driverData.udid, "simlock-baseline-device-1", sourcesSetPath),
        },
      ],
    },
  ])("$call waits ios.simulator.createTimeoutMs", async ({ act, seeded, steps }) => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      ...steps,
    ]);
    scopedRunners.push(runner);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    const clock = new FakeClock();
    const config = { simulator: { audio: true, createTimeoutMs: 120_000, headless: true } };
    const driver = await IosSimctlDriver.create({
      clock,
      config,
      database: seeded ? await seededDatabase() : await memorySourceDatabase(),
      driverConfig: { deviceRoot },
      filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: runner,
      simlockHome: "/home/.simlock",
    });
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

    const outcome = act(driver);
    const settled = outcome.catch((error: unknown) => error);
    const state = promiseState(outcome);
    await waitForCalls(runner, steps.length + 1);
    clock.advance(119_999);
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();

    expect(state.state).toBe("pending");
    clock.advance(1);
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    expect(state.state).toBe("rejected");
    expect(await settled).toMatchObject({
      message: expect.stringMatching(/timed out after 120000ms$/),
    });
  });

  const coreSimulatorRoot = "/CoreSim";

  it.each([
    {
      call: "a provision's clone under deviceSet default",
      act: (driver: IosSimctlDriver) => driver.provision(spec),
      deleteArgs: (udid: string) => ["simctl", "delete", udid],
      hung: [
        "simctl",
        "--set",
        unownedSourcesSet,
        "clone",
        seedUdid,
        driverData.name,
        join(coreSimulatorRoot, "Devices"),
      ],
      isDefault: true,
      seeded: true,
      steps: [],
    },
    {
      call: "a seed's create",
      act: (driver: IosSimctlDriver) => driver.provision(spec),
      deleteArgs: (udid: string) => simctl("delete", udid).args,
      hung: simctl("create", "simlock-seed-device-1", driverData.deviceTypeId, driverData.runtimeId)
        .args,
      isDefault: false,
      seeded: false,
      steps: [],
    },
    {
      call: "a baseline's clone",
      act: (driver: IosSimctlDriver) =>
        driver.saveSource({
          address: driverData.udid,
          deviceId: driverData.udid,
          driverData,
          physical: false,
        }),
      deleteArgs: (udid: string) => sourcesSimctl("delete", udid).args,
      hung: simctl("clone", driverData.udid, "simlock-baseline-device-1", sourcesSetPath).args,
      isDefault: false,
      seeded: false,
      steps: [
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        { match: simctl("shutdown", driverData.udid) },
      ],
    },
  ])(
    "a create or clone that answers after its limit deletes the simulator it names in its own set ($call)",
    async ({ act, deleteArgs, hung, isDefault, seeded, steps }) => {
      const devicesDir = join(coreSimulatorRoot, "Devices");
      const lateUdid = "00000000-0000-0000-0000-0000000000c1";
      const list = isDefault
        ? { args: ["simctl", "list", "-j", "devicetypes", "runtimes"], command: "xcrun" }
        : listInvocation;
      const scripted = new ScriptedProcessRunner([
        { match: list, result: { code: 0, stderr: "", stdout: listFixture } },
        ...steps,
        { match: { args: deleteArgs(lateUdid), command: "xcrun" } },
      ]);
      if (!isDefault) scopedRunners.push(scripted);
      let answer: ((result: ProcessResult) => void) | undefined;
      const runner: ProcessRunner = {
        run: scripted.run.bind(scripted),
        spawnStreaming: scripted.spawnStreaming.bind(scripted),
        spawn(
          command: string,
          args: readonly string[],
          options?: ProcessRunOptions,
        ): ProcessHandle {
          if (args.join(" ") !== hung.join(" ")) {
            return scripted.spawn(command, args, options);
          }
          scripted.calls.push({ args: [...args], command, options: options ?? {} });
          // why: `simctl clone` asks CoreSimulator's service for the copy; a signal ends only the
          // `simctl` process, so the copy still finishes, and it prints the UDID only if it is alive.
          const result = new Promise<ProcessResult>((resolve) => {
            answer = resolve;
          });
          const empty = (async function* () {})();
          return {
            kill() {
              answer?.({ code: null, stderr: "", stdout: "" });
            },
            pid: 99,
            stderr: empty,
            stdout: empty,
            unref() {},
            wait: () => result,
          };
        },
      };
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem, isDefault ? unownedSourcesSet : sourcesSetPath);
      const clock = new FakeClock();
      const driver = await IosSimctlDriver.create({
        database: seeded ? await seededDatabase() : await memorySourceDatabase(),
        clock,
        ...(isDefault ? { coreSimulatorRoot } : {}),
        driverConfig: isDefault ? { deviceSet: "default" } : { deviceRoot },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

      const call = act(driver).catch((error: unknown) => error);
      await vi.waitFor(() => expect(answer).toBeDefined());
      clock.advance(30_000);
      const failure = await call;
      await filesystem.mkdirp(`${devicesDir}/${lateUdid}/data`);
      answer?.({ code: 0, stderr: "", stdout: `${lateUdid}\n` });
      for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();

      expect(failure).toBeInstanceOf(DriverCrashError);
      expect((failure as Error).message).toMatch(/timed out after 30000ms$/);
      expect(
        scripted.calls.filter((entry) => entry.args.includes("delete")).map((entry) => entry.args),
      ).toEqual([deleteArgs(lateUdid)]);
    },
  );
});

/** why: Records the mode each `mkdirp` was asked for, because `MemoryFilesystem` creates every directory owner-only by default and so cannot show a caller that left the mode out. */
class ModeRecordingFilesystem extends MemoryFilesystem {
  readonly mkdirpModes = new Map<string, number | undefined>();

  override async mkdirp(
    path: string,
    options?: Parameters<MemoryFilesystem["mkdirp"]>[1],
  ): Promise<void> {
    this.mkdirpModes.set(path, options?.mode);
    await super.mkdirp(path, options);
  }
}
