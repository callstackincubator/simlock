import { describe, it, expect } from "vitest";
import {
  OWNED_ROOT_MARKER_FILE,
  OwnedRootError,
  PassthroughRefusedError,
} from "../../core/index.js";
import {
  type Filesystem,
  ScriptedProcessRunner,
  MemoryFilesystem,
  FakeClock,
  FakeBytePipeLauncher,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  driverData,
  deviceRoot,
  simctlArgs,
  deviceHubEdit,
  plantManagedDevice,
  instanceId,
} from "./test-slim.js";
import {
  PHYSICAL_DEVICE,
  listFixture,
  prepareFull,
  seedUdid,
  seededDatabase,
  simctlPassthrough,
  spec,
  throwawayUdid,
} from "./test-index.js";

describe("IosSimctlDriver device set", () => {
  const coreSimulatorRoot = "/CoreSim";
  const runtimeImage = {
    build: "23E244",
    identifier: "IMG-26.4-23E244",
    platformIdentifier: "com.apple.platform.iphonesimulator",
    runtimeIdentifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
    sizeBytes: 1_000,
    state: "Ready",
    version: "26.4",
  };
  const imageList = JSON.stringify({ [runtimeImage.identifier]: runtimeImage });
  const emptyDevices = JSON.stringify({ devices: {} });

  interface Step {
    readonly args: readonly string[];
    readonly scoped: boolean;
    readonly sources?: true;
    readonly stdout?: string;
  }

  async function plantDevice(filesystem: Filesystem, devicesDir: string): Promise<void> {
    await filesystem.mkdirp(`${devicesDir}/${driverData.udid}/data`);
  }

  it.each([
    ["unset", {}, deviceRoot, true, `${deviceRoot}/sources`, false],
    ["simlock", { deviceSet: "simlock" }, deviceRoot, true, `${deviceRoot}/sources`, false],
    [
      "default",
      { deviceSet: "default" },
      `${coreSimulatorRoot}/Devices`,
      false,
      "/home/.simlock/devices/ios-sources",
      true,
    ],
  ] as const)(
    "the driver given deviceSet %s selects simctl scope and whether a ready device needs reboot before grant",
    async (_case, config, devicesDir, scoped, sourcesSet, rebootBeforeGrant) => {
      const steps: Step[] = [
        { args: ["list", "-j", "devicetypes", "runtimes"], scoped: true, stdout: listFixture },
        {
          args: ["create", "simlock-seed-device-1", driverData.deviceTypeId, driverData.runtimeId],
          scoped: true,
          stdout: `${throwawayUdid}\n`,
        },
        { args: ["boot", throwawayUdid], scoped: true },
        { args: ["bootstatus", throwawayUdid, "-b"], scoped: true },
        { args: ["listapps", throwawayUdid], scoped: true },
        { args: ["shutdown", throwawayUdid], scoped: true },
        {
          args: ["clone", throwawayUdid, "simlock-seed-device-1", sourcesSet],
          scoped: true,
          stdout: `${seedUdid}\n`,
        },
        { args: ["delete", throwawayUdid], scoped: true },
        {
          args: ["clone", seedUdid, driverData.name, devicesDir],
          scoped: true,
          sources: true,
          stdout: `${driverData.udid}\n`,
        },
        { args: ["boot", driverData.udid], scoped: true },
        { args: ["bootstatus", driverData.udid, "-b"], scoped: true },
        { args: ["listapps", driverData.udid], scoped: true },
        { args: ["shutdown", driverData.udid], scoped: true },
        { args: ["delete", driverData.udid], scoped: true },
        { args: ["list", "-j", "devices"], scoped: true, stdout: emptyDevices },
        { args: ["runtime", "list", "-j"], scoped: true, stdout: imageList },
        { args: ["list", "-j", "devices"], scoped: false, stdout: emptyDevices },
        { args: ["runtime", "delete", runtimeImage.identifier], scoped: true },
        { args: ["runtime", "list", "-j"], scoped: true, stdout: "{}" },
        { args: ["runtime", "list", "-j"], scoped: true, stdout: "{}" },
        { args: ["list", "-j", "devices"], scoped: false, stdout: emptyDevices },
      ];
      const argvOf = (step: Step): string[] =>
        step.sources === true
          ? ["simctl", "--set", sourcesSet, ...step.args]
          : step.scoped && scoped
            ? simctlArgs(...step.args)
            : ["simctl", ...step.args];
      const runner = new ScriptedProcessRunner(
        steps.flatMap((step) => [
          ...(!scoped && step.args[0] === "boot" && step.args[1] === driverData.udid
            ? deviceHubEdit(
                `Set :DevicePreferences:${driverData.udid}:pasteboardSyncEnabled false`,
              ).map((match) => ({ match }))
            : []),
          {
            match: { args: argvOf(step), command: "xcrun" },
            ...(step.stdout === undefined
              ? {}
              : { result: { code: 0, stderr: "", stdout: step.stdout } }),
          },
          ...(!scoped && step.args[0] === "delete" && step.args[1] === driverData.udid
            ? deviceHubEdit(`Delete :DevicePreferences:${driverData.udid}`).map((match) => ({
                match,
              }))
            : []),
        ]),
      );
      const filesystem = new MemoryFilesystem();
      await plantDevice(filesystem, devicesDir);
      if (scoped) await plantManagedDevice(filesystem);
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot,
        driverConfig: scoped ? { deviceRoot, ...config } : config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      });
      expect(driver.rebootReadyBeforeGrant).toBe(rebootBeforeGrant);
      const device = { address: driverData.udid, deviceId: driverData.udid, driverData };

      await expect(
        driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" }),
      ).resolves.toBeDefined();
      await driver.provision(spec);
      await expect(filesystem.exists(`${sourcesSet}/${OWNED_ROOT_MARKER_FILE}`)).resolves.toBe(
        !scoped,
      );
      await driver.makeReady(device, prepareFull);
      await driver.destroy(device);
      await driver.listManaged();
      await driver.removeComponent(
        { build: runtimeImage.build, image: runtimeImage.identifier },
        { signal: new AbortController().signal },
      );

      expect(
        runner.calls.filter((call) => call.command === "xcrun").map((call) => call.args),
      ).toEqual(steps.map(argvOf));
    },
  );

  it.each([
    ["Default", { deviceSet: "Default" }, "Default", 'but it is "Default"'],
    ["the empty string", { deviceSet: "" }, "", 'but it is ""'],
    ["a boolean", { deviceSet: true }, "true", "but it is true"],
    [
      "default with a deviceRoot",
      { deviceSet: "default", deviceRoot: "/Volumes/sims" },
      "default",
      'drivers.ios.deviceRoot names Simlock\'s own set, but drivers.ios.deviceSet is "default". Remove one of them.',
    ],
  ] as const)(
    "refuses iOS with invalid-device-set when deviceSet is %s",
    async (_case, config, root, detail) => {
      const create = async (driverConfig: Record<string, string | number | boolean>) =>
        IosSimctlDriver.create({
          database: await memorySourceDatabase(),
          clock: new FakeClock(),
          coreSimulatorRoot,
          driverConfig,
          filesystem: new MemoryFilesystem(),
          idGenerator: { generate: () => "device-1" },
          instanceId,
          processRunner: new ScriptedProcessRunner([]),
          simlockHome: "/home/.simlock",
        });

      await expect(create({ deviceSet: "default" })).resolves.toBeInstanceOf(IosSimctlDriver);
      const failure = await create(config)
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OwnedRootError);
      expect(failure).toMatchObject({
        message: expect.stringContaining(detail),
        path: root,
        platform: "ios",
        reason: "invalid-device-set",
      });
      expect((failure as Error).message).toMatch(/^Refusing the ios device set: /);
    },
  );

  it("an operator who switches with leftovers gets device-set-changed, and an unreadable folder gets unreadable", async () => {
    const ownRoot = "/home/.simlock/devices/ios";
    const xcodeDevices = `${coreSimulatorRoot}/Devices`;
    const [first, second, third] = [1, 2, 3].map(
      (n) => `00000000-0000-0000-0000-00000000000${String(n)}`,
    );
    const mark = (owner: string) => JSON.stringify({ instanceId: owner, token: "t", udid: "u" });
    const steps: readonly [
      string,
      Record<string, string>,
      (fs: MemoryFilesystem) => Promise<void>,
      { readonly message?: string; readonly path?: string; readonly reason: string } | undefined,
    ][] = [
      [
        "default with two devices in Simlock's set",
        { deviceSet: "default" },
        async (fs) => {
          await fs.mkdirp(`${ownRoot}/${second}`);
          await fs.mkdirp(`${ownRoot}/${first}`);
          await fs.writeFileAtomic(`${ownRoot}/${OWNED_ROOT_MARKER_FILE}`, "{}");
        },
        {
          message: `Refusing the ios device set: Simlock's own set at ${ownRoot} still holds 2 simulator(s) (${first}, ${second}). Set drivers.ios.deviceSet back to simlock, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot} delete <udid>\`, or, for a seed in the sources set, \`xcrun simctl --set ${ownRoot}/sources delete <udid>\`.`,
          path: ownRoot,
          reason: "device-set-changed",
        },
      ],
      [
        "default with a seed in the sources set Simlock's own set held",
        { deviceSet: "default" },
        async (fs) => {
          await fs.mkdirp(`${ownRoot}/sources/${third}`);
          await fs.mkdirp(`${ownRoot}/${first}`);
          await fs.writeFileAtomic(`${ownRoot}/${OWNED_ROOT_MARKER_FILE}`, "{}");
        },
        {
          message: `Refusing the ios device set: Simlock's own set at ${ownRoot} still holds 2 simulator(s) (${first}, ${third}). Set drivers.ios.deviceSet back to simlock, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot} delete <udid>\`, or, for a seed in the sources set, \`xcrun simctl --set ${ownRoot}/sources delete <udid>\`.`,
          path: ownRoot,
          reason: "device-set-changed",
        },
      ],
      [
        "simlock with a seed in the sources set deviceSet default used",
        { deviceSet: "simlock" },
        async (fs) => {
          await fs.mkdirp(`${ownRoot}-sources/${second}`);
        },
        {
          message: `Refusing the ios device set: Simlock's sources set at ${ownRoot}-sources still holds 1 simulator(s) (${second}). Set drivers.ios.deviceSet back to default, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot}-sources delete <udid>\`. Run \`simlock nuke --delete-devices\` again afterwards, so Simlock drops its record of them.`,
          path: `${ownRoot}-sources`,
          reason: "device-set-changed",
        },
      ],
      [
        "default with Simlock's set empty",
        { deviceSet: "default" },
        async (fs) => {
          await fs.mkdirp(ownRoot);
          await fs.writeFileAtomic(`${ownRoot}/${OWNED_ROOT_MARKER_FILE}`, "{}");
        },
        undefined,
      ],
      ["default with no root folder", { deviceSet: "default" }, async () => undefined, undefined],
      [
        "simlock with a device of this instance in Xcode's set",
        { deviceSet: "simlock" },
        async (fs) => {
          await fs.mkdirp(`${xcodeDevices}/${third}`);
          await fs.writeFileAtomic(`${xcodeDevices}/${third}/simlock-mark.json`, mark(instanceId));
        },
        {
          message: `Refusing the ios device set: Xcode's device set still holds 1 of this Simlock's simulator(s) (${third}). Set drivers.ios.deviceSet back to default, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl delete <udid>\`.`,
          path: xcodeDevices,
          reason: "device-set-changed",
        },
      ],
      [
        "simlock with only unmarked, other-instance and corrupt devices in Xcode's set",
        { deviceSet: "simlock" },
        async (fs) => {
          await fs.mkdirp(`${xcodeDevices}/${first}`);
          await fs.mkdirp(`${xcodeDevices}/${second}`);
          await fs.writeFileAtomic(`${xcodeDevices}/${second}/simlock-mark.json`, mark("other"));
          await fs.mkdirp(`${xcodeDevices}/${third}`);
          await fs.writeFileAtomic(`${xcodeDevices}/${third}/simlock-mark.json`, "{broken");
        },
        undefined,
      ],
      [
        "default with Simlock's folder unreadable",
        { deviceSet: "default" },
        async (fs) => {
          await fs.mkdirp(ownRoot);
          fs.defineFailure(ownRoot, "EACCES");
        },
        { path: ownRoot, reason: "unreadable" },
      ],
      [
        "simlock with Xcode's folder unreadable",
        { deviceSet: "simlock" },
        async (fs) => {
          await fs.mkdirp(xcodeDevices);
          fs.defineFailure(xcodeDevices, "EACCES");
        },
        { path: xcodeDevices, reason: "unreadable" },
      ],
    ];

    for (const [name, config, plant, expected] of steps) {
      const filesystem = new MemoryFilesystem();
      await plant(filesystem);
      const runner = new ScriptedProcessRunner([]);
      const failure = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot,
        driverConfig: config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: runner,
        simlockHome: "/home/.simlock",
      })
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect(runner.calls, name).toEqual([]);
      if (expected === undefined) {
        expect(failure, name).toBeUndefined();
      } else {
        expect(failure, name).toBeInstanceOf(OwnedRootError);
        expect(failure, name).toMatchObject({ ...expected, platform: "ios" });
      }
    }
  });

  it.each([
    ["simlock", { deviceRoot, deviceSet: "simlock" }, deviceRoot],
    ["default", { deviceSet: "default" }, `${coreSimulatorRoot}/Devices`],
  ] as const)(
    "a new simulator's marks name this instance under deviceSet %s",
    async (setting, config, devicesDir) => {
      const scoped = setting === "simlock";
      const argv = (...args: string[]) => (scoped ? simctlArgs(...args) : ["simctl", ...args]);
      const marks = [
        `${devicesDir}/${driverData.udid}/data/simlock-mark.json`,
        `${devicesDir}/${driverData.udid}/simlock-mark.json`,
      ];
      const driverFor = async (steps: readonly (readonly [string[], string?])[]) => {
        const runner = new ScriptedProcessRunner(
          steps.map(([args, stdout]) => ({
            match: { args, command: "xcrun" },
            ...(stdout === undefined ? {} : { result: { code: 0, stderr: "", stdout } }),
          })),
        );
        const filesystem = new MemoryFilesystem();
        if (scoped) await plantManagedDevice(filesystem);
        else await filesystem.mkdirp(`${devicesDir}/${driverData.udid}/data`);
        const driver = await IosSimctlDriver.create({
          database: await seededDatabase(),
          clock: new FakeClock(),
          coreSimulatorRoot,
          driverConfig: config,
          filesystem,
          idGenerator: { generate: () => "device-1" },
          instanceId,
          processRunner: runner,
          simlockHome: "/home/.simlock",
        });
        return { driver, filesystem, runner };
      };
      const created = [
        argv("list", "-j", "devicetypes", "runtimes"),
        [
          "simctl",
          "--set",
          scoped ? `${deviceRoot}/sources` : "/home/.simlock/devices/ios-sources",
          "clone",
          seedUdid,
          driverData.name,
          devicesDir,
        ],
      ];

      const { driver, filesystem } = await driverFor([
        [created[0] ?? [], listFixture],
        [created[1] ?? [], `${driverData.udid}\n`],
      ]);
      await driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
      await driver.provision(spec);
      for (const path of marks) {
        expect(JSON.parse(await filesystem.readFile(path)), path).toMatchObject({ instanceId });
      }

      if (scoped) return;
      const failing = await driverFor([
        [created[0] ?? [], listFixture],
        [created[1] ?? [], `${driverData.udid}\n`],
        [argv("delete", driverData.udid)],
      ]);
      await failing.filesystem.rm(`${devicesDir}/${driverData.udid}/data`);
      await failing.driver.resolveSpec({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
      await expect(failing.driver.provision(spec)).rejects.toThrow();
      expect(failing.runner.calls.at(-1)).toEqual({
        args: argv("delete", driverData.udid),
        command: "xcrun",
        options: { timeoutMs: 30_000 },
      });
    },
  );

  it("under deviceSet default listManaged reports only devices whose durable mark names this instance", async () => {
    const devicesDir = `${coreSimulatorRoot}/Devices`;
    const udid = (n: number) => `00000000-0000-0000-0000-00000000010${String(n)}`;
    const mark = (owner?: string) =>
      JSON.stringify({ ...(owner === undefined ? {} : { instanceId: owner }), token: "t" });
    const filesystem = new MemoryFilesystem();
    const cases = [
      { durable: mark(instanceId), erasable: mark(instanceId), listed: true, name: "simlock-0" },
      { durable: mark(instanceId), erasable: undefined, listed: true, name: "simlock-9" },
      { durable: undefined, erasable: mark(instanceId), listed: false, name: "no-durable" },
      { durable: mark(), erasable: mark(), listed: false, name: "no-instance" },
      { durable: mark("other"), erasable: mark("other"), listed: false, name: "another" },
      { durable: undefined, erasable: undefined, listed: false, name: "simlock-1" },
    ];
    for (const [index, entry] of cases.entries()) {
      await filesystem.mkdirp(`${devicesDir}/${udid(index)}/data`);
      if (entry.durable !== undefined) {
        await filesystem.writeFileAtomic(
          `${devicesDir}/${udid(index)}/simlock-mark.json`,
          entry.durable,
        );
      }
      if (entry.erasable !== undefined) {
        await filesystem.writeFileAtomic(
          `${devicesDir}/${udid(index)}/data/simlock-mark.json`,
          entry.erasable,
        );
      }
    }
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["simctl", "list", "-j", "devices"], command: "xcrun" },
        result: {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-5": cases.map((entry, index) => ({
                dataPath: `${devicesDir}/${udid(index)}/data`,
                name: entry.name,
                state: "Shutdown",
                udid: udid(index),
              })),
            },
          }),
        },
      },
    ]);
    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      coreSimulatorRoot,
      driverConfig: { deviceSet: "default" },
      filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: runner,
      simlockHome: "/home/.simlock",
    });

    const reality = await driver.listManaged();

    expect(reality.devices.map((device) => [device.deviceId, device.mark?.erasable])).toEqual([
      [udid(0), "t"],
      [udid(1), undefined],
    ]);
    await expect(driver.findLegacy(udid(0))).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(1);
  });

  it("under deviceSet default foreignDevices and the removal's unused count take only devices this instance's mark does not name", async () => {
    const devicesDir = `${coreSimulatorRoot}/Devices`;
    const udids = ["A", "B", "C"].map((n) => `0000000${n}-0000-0000-0000-000000000000`);
    const devices = (used: boolean) =>
      JSON.stringify({
        devices: {
          [runtimeImage.runtimeIdentifier]: udids.map((udid) => ({
            ...(used ? { lastUsedAt: "2026-10-01T12:00:00Z" } : {}),
            name: "d",
            state: "Shutdown",
            udid,
          })),
        },
      });
    const driverWith = async (steps: readonly (readonly [readonly string[], string?])[]) => {
      const filesystem = new MemoryFilesystem();
      const marked = [instanceId, undefined, "other"] as const;
      for (const [index, udid] of udids.entries()) {
        await filesystem.mkdirp(`${devicesDir}/${udid}`);
        const owner = marked[index];
        if (owner !== undefined) {
          await filesystem.writeFileAtomic(
            `${devicesDir}/${udid}/simlock-mark.json`,
            JSON.stringify({ instanceId: owner, token: "t" }),
          );
        }
      }
      return IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot,
        driverConfig: { deviceSet: "default" },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner(
          steps.map(([args, stdout]) => ({
            match: { args: [...args], command: "xcrun" },
            ...(stdout === undefined ? {} : { result: { code: 0, stderr: "", stdout } }),
          })),
        ),
        simlockHome: "/home/.simlock",
      });
    };
    const runtimeList = [["simctl", "runtime", "list", "-j"], imageList] as const;
    const deviceList = (used: boolean) =>
      [["simctl", "list", "-j", "devices"], devices(used)] as const;

    const listing = await driverWith([runtimeList, deviceList(true)]);
    const [component] = await listing.listComponents();
    expect(component?.foreignDevices).toBe(2);

    const removing = await driverWith([
      runtimeList,
      deviceList(false),
      [["simctl", "runtime", "delete", runtimeImage.identifier]],
      [["simctl", "runtime", "list", "-j"], "{}"],
      [["simctl", "runtime", "list", "-j"], "{}"],
      deviceList(false),
    ]);
    const removal = await removing.removeComponent(
      { build: runtimeImage.build, image: runtimeImage.identifier },
      { signal: new AbortController().signal },
    );
    expect(removal.residue).toContain("2 never-used simulators");
  });

  it.each([
    ["simlock", { deviceRoot, deviceSet: "simlock" }, { SIMLOCK_IOS_DEVICE_SET: deviceRoot }],
    ["default", { deviceSet: "default" }, {}],
  ] as const)(
    "a lease holder and the screen capture get the device set only under deviceSet %s",
    async (_setting, config, leaseEnvironment) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/dist/bin");
      await filesystem.writeFileAtomic("/dist/bin/simlock-screen-capture", "");
      const launcher = new FakeBytePipeLauncher();
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        coreSimulatorRoot,
        driverConfig: config,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        screenCapture: {
          baseEnvironment: { PATH: "/usr/bin", SIMLOCK_IOS_DEVICE_SET: "/from/the/daemon" },
          command: "/dist/bin/simlock-screen-capture",
          launcher,
        },
        simlockHome: "/home/.simlock",
      });
      const capture = driver.screenCapture;
      if (capture === undefined) throw new Error("the driver offers no screen capture");

      await capture.open(
        { address: driverData.udid, deviceId: driverData.udid, driverData, physical: false },
        { bitrateKbps: 1_500, fps: 30, maxDimension: 720 },
        new AbortController().signal,
      );

      expect(driver.virtualLeaseEnvironment()).toEqual(leaseEnvironment);
      expect(
        driver.leaseEnvironment({
          address: driverData.udid,
          deviceId: driverData.udid,
          driverData,
        }),
      ).toEqual(leaseEnvironment);
      expect(driver.leaseEnvironment(PHYSICAL_DEVICE)).toEqual({
        SIMLOCK_DEVICE_UDID: PHYSICAL_DEVICE.deviceId,
      });
      expect(launcher.starts[0]?.env).toEqual({
        PATH: "/usr/bin",
        ...leaseEnvironment,
      });
    },
  );

  it("simlock simctl under deviceSet default runs plain xcrun simctl and keeps its refusals", async () => {
    const driver = await IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      clock: new FakeClock(),
      coreSimulatorRoot,
      driverConfig: { deviceSet: "default" },
      filesystem: new MemoryFilesystem(),
      idGenerator: { generate: () => "device-1" },
      instanceId,
      processRunner: new ScriptedProcessRunner([]),
      simlockHome: "/home/.simlock",
    });

    await expect(
      simctlPassthrough(driver, ["install", driverData.udid, "app.app"]),
    ).resolves.toEqual({
      args: ["simctl", "install", driverData.udid, "app.app"],
      command: "xcrun",
      env: {},
    });
    for (const refused of [
      ["erase", driverData.udid],
      ["shutdown", "all"],
      ["--set", "/tmp", "list"],
    ]) {
      await expect(simctlPassthrough(driver, refused), refused.join(" ")).rejects.toBeInstanceOf(
        PassthroughRefusedError,
      );
    }
  });
});
