import { afterEach, expect, it, describe } from "vitest";
import { DriverCrashError, BootTimeoutError } from "../../core/index.js";
import { ScriptedProcessRunner, FakeClock, MemoryFilesystem } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  type PlantedSource,
  plantBytes,
  plantSource,
  memorySourceDatabase,
  readBytes,
} from "./testing.js";
import {
  deviceRoot,
  sourcesSetPath,
  driverData,
  waitForCalls,
  FaultyFilesystem,
  overridesFolder,
  overridesPath,
  overridesPlist,
  plantManagedDevice,
  simctl,
} from "./test-slim.js";
import {
  RecordingLogger,
  UNSCOPED_LEGACY_CALLS,
  createDriver,
  launchServicesFiles,
  listFixture,
  listInvocation,
  plantLaunchServices,
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

interface Catalog {
  devicetypes: { identifier: string }[];
  runtimes: { buildversion?: string; identifier: string }[];
}

describe("IosSimctlDriver", () => {
  it("a create command still silent after the second limit is killed and logged with the name it was asked to create", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { hangs: true, match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot) },
    ]);
    const logger = new RecordingLogger();
    const clock = new FakeClock();
    const driver = await createDriver(runner, clock, undefined, await seededDatabase(), logger);
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

    const provision = driver.provision(spec).catch((error: unknown) => error);
    await waitForCalls(runner, 2);
    const clone = promiseState(runner.handles[1]!.wait());
    clock.advance(30_000);
    await provision;
    clock.advance(299_999);
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    expect(clone.state).toBe("pending");
    expect(logger.warnings).toEqual([]);

    clock.advance(1);
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();

    expect(clone.state).toBe("fulfilled");
    expect(logger.warnings).toEqual([
      `simctl clone ${seedUdid} ${driverData.name} ${deviceRoot} gave no simulator after its limit`,
    ]);
  });

  it("a seed is not deleted, even by a deletion queued during the clone, while a clone that answered late is still running", async () => {
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { hangs: true, match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot) },
      { match: sourcesSimctl("shutdown", seedUdid) },
      { match: sourcesSimctl("delete", seedUdid) },
    ]);
    const clock = new FakeClock();
    const driver = await createDriver(runner, clock, undefined, await seededDatabase());
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
    const [listed] = await driver.listSources();

    const provision = driver.provision(spec).catch((error: unknown) => error);
    await waitForCalls(runner, 3);
    const destroyed = driver.destroySource(listed?.id ?? "");
    const destroy = promiseState(destroyed);
    clock.advance(30_000);
    await provision;
    for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();

    expect(destroy.state).toBe("pending");
    expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "list", "clone"]);

    clock.advance(300_000);
    await destroyed;

    expect(runner.calls.map((call) => call.args[3])).toEqual([
      "list",
      "list",
      "clone",
      "shutdown",
      "delete",
    ]);
  });

  it("provision deletes the clone and throws when the LaunchServices database cannot be dropped", async () => {
    const filesystem = new FaultyFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await plantLaunchServices(filesystem, `${deviceRoot}/${driverData.udid}`);
    filesystem.failing = "rm";
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      {
        match: sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
      { match: simctl("delete", driverData.udid) },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem, await seededDatabase());
    await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

    await expect(driver.provision(spec)).rejects.toThrow("disk full");

    expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "clone", "delete"]);
  });

  it.each([
    {
      name: "a named source is copied instead of the seed, with its lineage swapped for the copy's own UDID",
      id: "planted-named",
      cloned: true,
    },
    { name: "an unknown source is refused", id: "nope", cloned: false },
    { name: "a stale source is refused", id: "planted-old", cloned: false },
    { name: "a source with no lineage is refused", id: "planted-unlineaged", cloned: false },
    {
      name: "a baseline whose simulator is gone is refused with what to do",
      id: "planted-gone",
      cloned: false,
      refusal: "source planted-gone is stale: its simulator is gone; save it again",
    },
  ])("provision with a source: $name", async ({ id, cloned, refusal }) => {
    const namedUdid = "00000000-0000-0000-0000-0000000000bb";
    const oldUdid = "00000000-0000-0000-0000-0000000000cc";
    const unlineagedUdid = "00000000-0000-0000-0000-0000000000dd";
    const goneUdid = "00000000-0000-0000-0000-0000000000ff";
    const database = await seededDatabase();
    const kind = { deviceTypeId: driverData.deviceTypeId, runtimeId: driverData.runtimeId };
    const namedLineage = "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB";
    const planted = plantSource(database, {
      ...kind,
      files: [{ kind: "file", relativePath: "data/note.plist" }],
      kind: "baseline",
      lineage: [namedLineage],
      udid: namedUdid,
    });
    database
      .prepare("UPDATE ios_source_data SET source_id = 'planted-named' WHERE udid = ?")
      .run(namedUdid);
    database.prepare("UPDATE ios_source_files SET source_id = 'planted-named'").run();
    plantSource(planted, { ...kind, kind: "baseline", runtimeBuild: "23F77", udid: oldUdid });
    database
      .prepare("UPDATE ios_source_data SET source_id = 'planted-old' WHERE udid = ?")
      .run(oldUdid);
    plantSource(database, { ...kind, kind: "baseline", lineage: null, udid: unlineagedUdid });
    database
      .prepare("UPDATE ios_source_data SET source_id = 'planted-unlineaged' WHERE udid = ?")
      .run(unlineagedUdid);
    plantSource(database, {
      ...kind,
      kind: "baseline",
      lineage: [namedLineage],
      udid: goneUdid,
    });
    database
      .prepare("UPDATE ios_source_data SET source_id = 'planted-gone' WHERE udid = ?")
      .run(goneUdid);
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await plantLaunchServices(filesystem, `${deviceRoot}/${driverData.udid}`);
    const note = `${deviceRoot}/${driverData.udid}/data/note.plist`;
    await plantBytes(filesystem, note, Buffer.from(`root /Devices/${namedLineage}/data`));
    const catalog = JSON.parse(listFixture) as {
      runtimes: { buildversion?: string; identifier: string }[];
    };
    for (const runtime of catalog.runtimes) {
      if (runtime.identifier === driverData.runtimeId) runtime.buildversion = "23F79";
    }
    const listed = JSON.stringify(catalog);
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listed } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listed } },
      {
        match: sourcesSimctl("clone", namedUdid, driverData.name, deviceRoot),
        result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
      },
    ]);
    // why: `createDriver` plants a folder for every ready row; the gone source's folder is the one a deleted simulator leaves missing.
    const driver = await createDriver(
      runner,
      new FakeClock(),
      filesystem,
      database,
      undefined,
      undefined,
      {},
      id !== "planted-gone",
    );
    if (id !== "planted-gone") {
      await plantSeedClone(filesystem, sourcesSetPath, namedUdid);
    }

    const provisioned = driver.provision(spec, { source: id });

    if (cloned) {
      await expect(provisioned).resolves.toMatchObject({
        deviceId: driverData.udid,
        driverData: { lineage: [namedLineage] },
      });
      expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "list", "clone"]);
      expect(
        (await readBytes(filesystem, note)).toString(),
        "the copy of a baseline names its own folder in place of the baseline's lineage",
      ).toBe(`root /Devices/${driverData.udid.toUpperCase()}/data`);
      expect(
        await launchServicesFiles(filesystem, `${deviceRoot}/${driverData.udid}`),
        "the copy of a source loses the LaunchServices database that names the source's folder",
      ).toEqual(["com.apple.LaunchServices.unregisteredtypes-501.db"]);
    } else {
      await expect(provisioned).rejects.toBeInstanceOf(DriverCrashError);
      if (refusal !== undefined) await expect(provisioned).rejects.toThrow(refusal);
      expect(runner.calls.map((call) => call.args[3])).not.toContain("clone");
    }
  });

  it.each([
    { name: "300 s old is kept", now: 300_000, destroyed: false },
    { name: "300.001 s old is destroyed", now: 300_001, destroyed: true },
  ])(
    "the next seed make of a kind destroys this process's own making row of that kind older than 300 s: a row $name",
    async ({ now, destroyed }) => {
      const stuckUdid = "00000000-0000-0000-0000-0000000000dd";
      const stuckThrowaway = "00000000-0000-0000-0000-0000000000ee";
      const database = plantSource(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        maker: "device-1",
        runtimeId: driverData.runtimeId,
        state: "making",
        throwawayUdid: stuckThrowaway,
        udid: stuckUdid,
      });
      const copyUdid = "00000000-0000-0000-0000-000000000002";
      const cloneInvocation = sourcesSimctl("clone", seedUdid, driverData.name, deviceRoot);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        ...(destroyed
          ? [
              { match: sourcesSimctl("shutdown", stuckUdid) },
              { match: sourcesSimctl("delete", stuckUdid) },
              { match: simctl("shutdown", stuckThrowaway) },
              { match: simctl("delete", stuckThrowaway) },
            ]
          : []),
        ...throwawaySeedSteps(),
        { match: cloneInvocation, result: { code: 0, stderr: "", stdout: `${copyUdid}\n` } },
      ]);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);
      await filesystem.mkdirp(`${deviceRoot}/${copyUdid}/data`);
      const driver = await createDriver(runner, new FakeClock(now), filesystem, database);

      await driver.provision(spec);

      expect(
        runner.calls
          .filter((call) => [stuckUdid, stuckThrowaway].includes(call.args[4] ?? ""))
          .map((call) => `${call.args[3] ?? ""} ${call.args[4] ?? ""}`),
      ).toEqual(
        destroyed
          ? [
              `shutdown ${stuckUdid}`,
              `delete ${stuckUdid}`,
              `shutdown ${stuckThrowaway}`,
              `delete ${stuckThrowaway}`,
            ]
          : [],
      );
      expect(
        database.prepare("SELECT udid FROM ios_source_data WHERE state = 'making'").all(),
      ).toEqual(destroyed ? [] : [{ udid: stuckUdid }]);
    },
  );

  it.each([
    {
      name: "simctl create fails",
      message: "Invalid runtime",
      script: [{ code: 1, op: "create" }],
      tail: [],
    },
    {
      name: "the seed's boot fails",
      message: `seed ${throwawayUdid} did not boot: `,
      script: [{ code: 1, op: "bootstatus" }],
      tail: ["shutdown", "delete"],
    },
    {
      name: "the seed's shutdown fails",
      message: "Unable to shutdown",
      script: [{ code: 1, op: "shutdown" }],
      tail: ["shutdown", "delete"],
    },
  ] as const)(
    "a seed make that fails because $name leaves no seed and no row, and the provision throws a DriverCrashError, never a BootTimeoutError",
    async ({ message, script, tail }) => {
      const failing = script[0];
      const steps = ["create", "boot", "bootstatus", "listapps", "shutdown"];
      const upTo = steps.indexOf(failing.op);
      const results = new Map<string, { code: number; stderr: string; stdout: string }>([
        ["create", { code: 0, stderr: "", stdout: `${throwawayUdid}\n` }],
      ]);
      const database = await memorySourceDatabase();
      const entries = steps.slice(0, upTo + 1).map((op) => {
        const match = simctl(
          ...(op === "create"
            ? ["create", "simlock-seed-device-1", driverData.deviceTypeId, driverData.runtimeId]
            : op === "bootstatus"
              ? [op, throwawayUdid, "-b"]
              : [op, throwawayUdid]),
        );
        if (op !== failing.op)
          return { match, ...(results.has(op) ? { result: results.get(op)! } : {}) };
        return "hangs" in failing
          ? { hangs: true, match }
          : { match, result: { code: failing.code, stderr: message, stdout: "" } };
      });
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        ...entries,
        ...tail.map((op) => ({ match: simctl(op, throwawayUdid) })),
      ]);
      const clock = new FakeClock();
      const driver = await createDriver(runner, clock, undefined, database);
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

      const provisioned = driver.provision(spec);
      void provisioned.catch(() => undefined);
      if ("hangs" in failing) {
        await waitForCalls(runner, entries.length + 1);
        clock.advance(300_000);
      }
      const error = await provisioned.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DriverCrashError);
      expect(error).not.toBeInstanceOf(BootTimeoutError);
      expect((error as Error).message).toContain(message);
      expect(runner.calls.map((call) => call.args[3])).toEqual([
        "list",
        ...steps.slice(0, upTo + 1),
        ...tail,
      ]);
      expect(runner.calls.slice(1).map((call) => call.args[2])).toEqual(
        runner.calls.slice(1).map(() => deviceRoot),
      );
      expect(database.prepare("SELECT COUNT(*) AS n FROM ios_source_data").get()).toEqual({ n: 0 });
    },
  );

  it.each([
    { name: "bootstatus does not finish", hangs: "bootstatus" },
    { name: "the installer never answers listapps", hangs: "listapps" },
  ] as const)(
    "a seed whose boot runs past ios.full.bootTimeoutMs because $name makes provision throw BootTimeoutError, as an Android seed's does, and leaves no seed and no row",
    async ({ hangs }) => {
      const bootSteps = ["boot", "bootstatus", "listapps"];
      const ran = bootSteps.slice(0, bootSteps.indexOf(hangs) + 1);
      const database = await memorySourceDatabase();
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
        {
          match: simctl(
            "create",
            "simlock-seed-device-1",
            driverData.deviceTypeId,
            driverData.runtimeId,
          ),
          result: { code: 0, stderr: "", stdout: `${throwawayUdid}\n` },
        },
        ...ran.map((op) => {
          const match = simctl(
            ...(op === "bootstatus" ? [op, throwawayUdid, "-b"] : [op, throwawayUdid]),
          );
          return op === hangs ? { hangs: true, match } : { match };
        }),
        ...["shutdown", "shutdown", "delete"].map((op) => ({ match: simctl(op, throwawayUdid) })),
      ]);
      const clock = new FakeClock();
      const driver = await createDriver(runner, clock, undefined, database, undefined, 2_000);
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

      const provisioned = driver.provision(spec);
      void provisioned.catch(() => undefined);
      await waitForCalls(runner, ran.length + 2);
      clock.advance(2_000);
      const error = await provisioned.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BootTimeoutError);
      expect((error as Error).message).toBe("Timed out waiting for device to boot: device-1");
      expect(runner.calls.map((call) => call.args[3])).toEqual([
        "list",
        "create",
        ...ran,
        "shutdown",
        "shutdown",
        "delete",
      ]);
      expect(database.prepare("SELECT COUNT(*) AS n FROM ios_source_data").get()).toEqual({ n: 0 });
    },
  );

  it.each([
    { name: "its runtime changed build", seedBuild: "23F77", runtimeBuild: "23F79", remade: true },
    { name: "its runtime is unchanged", seedBuild: "23F79", runtimeBuild: "23F79", remade: false },
    { name: "it recorded no build", seedBuild: undefined, runtimeBuild: "23F79", remade: false },
    {
      name: "its runtime lists no build now",
      seedBuild: "23F77",
      runtimeBuild: undefined,
      remade: false,
    },
    {
      name: "it has no lineage",
      lineage: null,
      seedBuild: "23F79",
      runtimeBuild: "23F79",
      remade: true,
    },
    {
      name: "its lineage is empty",
      lineage: [],
      seedBuild: "23F79",
      runtimeBuild: "23F79",
      remade: false,
    },
  ] as readonly {
    name: string;
    lineage?: readonly string[] | null;
    seedBuild: string | undefined;
    runtimeBuild: string | undefined;
    remade: boolean;
  }[])(
    "makes the seed again before copying it only when it is stale: $name -> remade $remade",
    async ({ lineage, seedBuild, runtimeBuild, remade }) => {
      const staleUdid = "00000000-0000-0000-0000-0000000000bb";
      const catalog = JSON.parse(listFixture) as {
        runtimes: { buildversion?: string; identifier: string }[];
      };
      for (const entry of catalog.runtimes) {
        if (entry.identifier === driverData.runtimeId && runtimeBuild !== undefined) {
          entry.buildversion = runtimeBuild;
        }
      }
      const planted = staleUdid;
      const throwaway = throwawaySeedSteps();
      const cloneOf = (udid: string) => sourcesSimctl("clone", udid, driverData.name, deviceRoot);
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: JSON.stringify(catalog) } },
        ...(remade
          ? [
              { match: sourcesSimctl("shutdown", staleUdid) },
              { match: sourcesSimctl("delete", staleUdid) },
              ...throwaway,
            ]
          : []),
        {
          match: cloneOf(remade ? seedUdid : staleUdid),
          result: { code: 0, stderr: "", stdout: `${driverData.udid}\n` },
        },
      ]);
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      await plantSeedClone(filesystem);
      const driver = await createDriver(
        runner,
        new FakeClock(),
        filesystem,
        await seededDatabase({
          udid: planted,
          ...(lineage === undefined ? {} : { lineage }),
          ...(seedBuild === undefined ? {} : { runtimeBuild: seedBuild }),
        }),
      );
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });

      await driver.provision(spec);

      expect(runner.calls.map((call) => call.args[3]).filter((verb) => verb !== "list")).toEqual(
        remade
          ? [
              "shutdown",
              "delete",
              "create",
              "boot",
              "bootstatus",
              "listapps",
              "shutdown",
              "clone",
              "delete",
              "clone",
            ]
          : ["clone"],
      );
    },
  );

  it.each<{
    name: string;
    edit: (catalog: Catalog) => void;
    planted?: Partial<PlantedSource>;
    persists?: true;
    /** why: the sources set no longer holds the source's simulator. */
    gone?: true;
    reason: string | undefined;
    /** why: the reason of the second read, when the catalog is back, where it differs from a reason that persists. */
    later?: string;
  }>([
    { name: "healthy", edit: () => undefined, reason: undefined },
    {
      name: "a seed has no lineage, which is remade and shows no reason",
      edit: () => undefined,
      planted: { lineage: null },
      reason: undefined,
    },
    {
      name: "a baseline was saved before lineages were kept",
      edit: () => undefined,
      planted: { kind: "baseline", lineage: null },
      persists: true,
      reason: "saved before simulators stopped sharing folders; save it again",
    },
    {
      name: "a baseline was saved from a simulator made before lineages were kept",
      edit: () => undefined,
      planted: { kind: "baseline", lineage: null, savedWithoutLineage: true },
      persists: true,
      reason:
        "saved from a simulator made before simulators stopped sharing folders; save it again from a new lease",
    },
    {
      name: "a baseline has a lineage",
      edit: () => undefined,
      planted: { kind: "baseline", lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"] },
      reason: undefined,
    },
    {
      name: "its runtime is gone",
      edit: (catalog: Catalog) => {
        catalog.runtimes = catalog.runtimes.filter(
          (entry) => entry.identifier !== driverData.runtimeId,
        );
      },
      reason: `runtime ${driverData.runtimeId} is not installed`,
    },
    {
      name: "its runtime changed build",
      edit: (catalog: Catalog) => {
        for (const entry of catalog.runtimes) {
          if (entry.identifier === driverData.runtimeId) entry.buildversion = "23F79";
        }
      },
      reason: `runtime ${driverData.runtimeId} changed from build 23F77 to 23F79`,
    },
    {
      name: "its device type is gone",
      edit: (catalog: Catalog) => {
        catalog.devicetypes = catalog.devicetypes.filter(
          (entry) => entry.identifier !== driverData.deviceTypeId,
        );
      },
      reason: `device type ${driverData.deviceTypeId} is not available`,
    },
    {
      name: "a seed's simulator is gone, which a new simulator does not clear",
      edit: () => undefined,
      gone: true,
      persists: true,
      reason: "its simulator is gone; the next lease of its kind makes it again",
    },
    {
      name: "a baseline's simulator is gone, which a new simulator does not clear",
      edit: () => undefined,
      gone: true,
      persists: true,
      planted: { kind: "baseline", lineage: ["AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB"] },
      reason: "its simulator is gone; save it again",
    },
    {
      name: "its runtime is gone and so is its simulator, so the runtime is named first, and the simulator once the runtime is back",
      edit: (catalog: Catalog) => {
        catalog.runtimes = catalog.runtimes.filter(
          (entry) => entry.identifier !== driverData.runtimeId,
        );
      },
      gone: true,
      later: "its simulator is gone; the next lease of its kind makes it again",
      reason: `runtime ${driverData.runtimeId} is not installed`,
    },
  ])(
    "lists a ready source with its model, version and size, and its staleReason when $name, which clears once it is back",
    async ({ edit, gone, later, persists, planted, reason }) => {
      const catalogOf = (change: (catalog: Catalog) => void) => {
        const catalog = JSON.parse(listFixture) as Catalog;
        for (const entry of catalog.runtimes) {
          if (entry.identifier === driverData.runtimeId) entry.buildversion = "23F77";
        }
        change(catalog);
        return JSON.stringify(catalog);
      };
      const runner = new ScriptedProcessRunner([
        { match: listInvocation, result: { code: 0, stderr: "", stdout: catalogOf(edit) } },
        {
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: catalogOf(() => undefined) },
        },
      ]);
      const database = plantSource(await memorySourceDatabase(), {
        deviceTypeId: driverData.deviceTypeId,
        runtimeBuild: "23F77",
        runtimeId: driverData.runtimeId,
        sizeBytes: 1_073_741_824,
        udid: seedUdid,
        ...planted,
      });
      const driver = await createDriver(
        runner,
        new FakeClock(),
        undefined,
        database,
        undefined,
        undefined,
        {},
        gone !== true,
      );

      expect(await driver.listSources()).toMatchObject([
        {
          kind: planted?.kind ?? "seed",
          model: "iPhone 16",
          osVersion: "26.5",
          sizeBytes: 1_073_741_824,
          ...(reason === undefined ? {} : { staleReason: reason }),
        },
      ]);
      // why: a lineage the source never had does not come back with the catalog, so its reason stays.
      const again = (await driver.listSources())[0];
      if (later !== undefined) expect(again).toHaveProperty("staleReason", later);
      else if (persists === true) expect(again).toHaveProperty("staleReason", reason);
      else expect(again).not.toHaveProperty("staleReason");
      expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "list"]);
    },
  );

  it("the first listSources of a process deletes another process's making rows and their simulators, keeps a row whose delete failed, and does not sweep again", async () => {
    const [gone, stuck, ready] = [1, 2, 3].map(
      (n) => `00000000-0000-0000-0000-0000000001${String(n)}0`,
    ) as [string, string, string];
    const database = await memorySourceDatabase();
    const kind = { deviceTypeId: driverData.deviceTypeId, runtimeId: driverData.runtimeId };
    plantSource(database, { ...kind, maker: "earlier-process", state: "making", udid: gone });
    plantSource(database, { ...kind, maker: "earlier-process", state: "making" });
    plantSource(database, { ...kind, maker: "earlier-process", state: "making", udid: stuck });
    plantSource(database, { ...kind, udid: ready });
    const runner = new ScriptedProcessRunner([
      { match: sourcesSimctl("shutdown", gone) },
      { match: sourcesSimctl("delete", gone) },
      { match: sourcesSimctl("shutdown", stuck) },
      { match: sourcesSimctl("delete", stuck), result: { code: 1, stderr: "busy", stdout: "" } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
    ]);
    const logger = new RecordingLogger();
    const driver = await createDriver(runner, new FakeClock(), undefined, database, logger);

    expect(await driver.listSources()).toHaveLength(1);
    await driver.listSources();

    expect(runner.calls.map((call) => [call.args[3], call.args[4]])).toEqual([
      ["shutdown", gone],
      ["delete", gone],
      ["shutdown", stuck],
      ["delete", stuck],
      ["list", "-j"],
      ["list", "-j"],
    ]);
    expect(logger.warnings).toEqual([
      expect.stringContaining(`could not remove leftover source ${stuck}:`),
    ]);
    expect(database.prepare("SELECT udid, state FROM ios_source_data ORDER BY udid").all()).toEqual(
      [
        { state: "making", udid: stuck },
        { state: "ready", udid: ready },
      ],
    );
  });

  it("listSources reports a simulator in the sources set that no row names as an orphan source, and destroySource deletes it", async () => {
    const orphanUdid = "00000000-0000-0000-0000-0000000000ee";
    const filesystem = new MemoryFilesystem();
    await plantManagedDevice(filesystem);
    await plantSeedClone(filesystem);
    await filesystem.mkdirp(`${deviceRoot}/sources/${seedUdid}`);
    await filesystem.mkdirp(`${deviceRoot}/sources/${orphanUdid}`);
    const database = await seededDatabase();
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: sourcesSimctl("shutdown", orphanUdid) },
      { match: sourcesSimctl("delete", orphanUdid) },
    ]);
    const driver = await createDriver(runner, new FakeClock(), filesystem, database);

    const sources = await driver.listSources();

    expect(sources.filter((source) => source.orphan !== true)).toHaveLength(1);
    expect(sources.filter((source) => source.orphan === true)).toEqual([
      { id: orphanUdid, kind: "seed", model: "unknown", orphan: true, osVersion: "unknown" },
    ]);
    await driver.destroySource(orphanUdid);
    expect(runner.calls.slice(1).map((call) => [call.args[3], call.args[4]])).toEqual([
      ["shutdown", orphanUdid],
      ["delete", orphanUdid],
    ]);
    await expect(
      driver.destroySource("00000000-0000-0000-0000-0000000000f0"),
    ).rejects.toBeInstanceOf(DriverCrashError);
  });

  it.each([
    {
      name: "deletes its simulator in the sources set and its row",
      deleteCode: 0,
      stderr: "",
      rows: 0,
    },
    {
      name: "keeps the row and throws when the delete fails",
      deleteCode: 1,
      stderr: "busy",
      rows: 1,
    },
    {
      name: "drops the row of a seed simctl no longer knows (Invalid device)",
      deleteCode: 148,
      stderr: `Invalid device: ${seedUdid}\n`,
      rows: 0,
    },
  ])("destroySource $name", async ({ deleteCode, stderr, rows }) => {
    const database = plantSource(await memorySourceDatabase(), {
      deviceTypeId: driverData.deviceTypeId,
      files: [{ kind: "file", relativePath: "data/a.plist" }],
      runtimeId: driverData.runtimeId,
      udid: seedUdid,
    });
    const runner = new ScriptedProcessRunner([
      { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
      { match: sourcesSimctl("shutdown", seedUdid) },
      {
        match: sourcesSimctl("delete", seedUdid),
        result: { code: deleteCode, stderr, stdout: "" },
      },
    ]);
    const driver = await createDriver(runner, new FakeClock(), undefined, database);
    const [listed] = await driver.listSources();

    const destroyed = driver.destroySource(listed?.id ?? "");

    if (rows === 0) await expect(destroyed).resolves.toBeUndefined();
    else await expect(destroyed).rejects.toBeInstanceOf(DriverCrashError);
    expect(runner.calls.map((call) => call.args[3])).toEqual(["list", "shutdown", "delete"]);
    expect(database.prepare("SELECT COUNT(*) AS n FROM ios_source_data").get()).toEqual({
      n: rows,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM ios_source_files").get()).toEqual({
      n: rows,
    });
  });

  it("deleting a baseline's simulator removes its launchd overrides folder, through destroySource, the leftover sweep and a failed save, and a failed delete keeps it", async () => {
    const baselineUdid = "00000000-0000-0000-0000-0000000000bb";
    const kind = { deviceTypeId: driverData.deviceTypeId, kind: "baseline" as const };
    const cases = [
      {
        name: "destroySource",
        plant: { ...kind, runtimeId: driverData.runtimeId, udid: baselineUdid },
        steps: [
          { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
          { match: sourcesSimctl("shutdown", baselineUdid) },
          { match: sourcesSimctl("delete", baselineUdid) },
        ],
        act: async (driver: Awaited<ReturnType<typeof createDriver>>) => {
          const [listed] = await driver.listSources();
          await driver.destroySource(listed?.id ?? "");
        },
      },
      {
        name: "the sweep of another process's making row",
        plant: {
          ...kind,
          maker: "earlier-process",
          runtimeId: driverData.runtimeId,
          state: "making" as const,
          udid: baselineUdid,
        },
        steps: [
          { match: sourcesSimctl("shutdown", baselineUdid) },
          { match: sourcesSimctl("delete", baselineUdid) },
        ],
        act: async (driver: Awaited<ReturnType<typeof createDriver>>) => {
          await driver.listSources();
        },
      },
      {
        name: "a save that fails after the clone",
        plant: undefined,
        steps: [
          { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
          { match: simctl("shutdown", driverData.udid) },
          {
            match: simctl("clone", driverData.udid, "simlock-baseline-device-1", sourcesSetPath),
            result: { code: 0, stderr: "", stdout: `${baselineUdid}\n` },
          },
          { match: sourcesSimctl("shutdown", baselineUdid) },
          { match: sourcesSimctl("delete", baselineUdid) },
        ],
        act: async (
          driver: Awaited<ReturnType<typeof createDriver>>,
          database: Awaited<ReturnType<typeof memorySourceDatabase>>,
        ) => {
          database.exec(
            "CREATE TRIGGER refuse_ready BEFORE UPDATE OF state ON ios_source_data BEGIN SELECT RAISE(ABORT, 'source row locked'); END",
          );
          await expect(
            driver.saveSource({
              address: driverData.udid,
              deviceId: driverData.udid,
              driverData,
              physical: false,
            }),
          ).rejects.toMatchObject({ message: expect.stringContaining("source row locked") });
        },
      },
      {
        name: "destroySource whose delete fails",
        plant: { ...kind, runtimeId: driverData.runtimeId, udid: baselineUdid },
        steps: [
          { match: listInvocation, result: { code: 0, stderr: "", stdout: listFixture } },
          { match: sourcesSimctl("shutdown", baselineUdid) },
          {
            match: sourcesSimctl("delete", baselineUdid),
            result: { code: 1, stderr: "busy", stdout: "" },
          },
        ],
        act: async (driver: Awaited<ReturnType<typeof createDriver>>) => {
          const [listed] = await driver.listSources();
          await expect(driver.destroySource(listed?.id ?? "")).rejects.toBeInstanceOf(
            DriverCrashError,
          );
        },
      },
    ];
    const outcomes: Record<string, { deleted: boolean; folderKept: boolean }> = {};
    for (const { name, plant, steps, act } of cases) {
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      const database = await memorySourceDatabase();
      if (plant !== undefined) plantSource(database, plant);
      // why: the save copies the lease's folder to the clone; a planted baseline already has its own.
      const from = plant === undefined ? driverData.udid : baselineUdid;
      await filesystem.mkdirp(overridesFolder(from));
      await filesystem.writeFileAtomic(overridesPath(from), overridesPlist({ "a.b": true }));
      const runner = new ScriptedProcessRunner(steps);
      const driver = await createDriver(runner, new FakeClock(), filesystem, database);

      await act(driver, database);

      outcomes[name] = {
        deleted: runner.calls.some(
          (call) => call.args.at(-2) === "delete" && call.args.at(-1) === baselineUdid,
        ),
        folderKept: await filesystem.exists(overridesFolder(baselineUdid)),
      };
    }
    expect(outcomes).toEqual({
      destroySource: { deleted: true, folderKept: false },
      "the sweep of another process's making row": { deleted: true, folderKept: false },
      "a save that fails after the clone": { deleted: true, folderKept: false },
      "destroySource whose delete fails": { deleted: true, folderKept: true },
    });
  });

  it("destroySource refuses an id that names no source, without running simctl", async () => {
    const runner = new ScriptedProcessRunner([]);
    const driver = await createDriver(runner);

    await expect(driver.destroySource("nope")).rejects.toBeInstanceOf(DriverCrashError);
    expect(runner.calls).toEqual([]);
  });
});
