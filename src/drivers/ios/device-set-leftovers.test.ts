import { describe, expect, it } from "vitest";

import { OwnedRootError, OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import { instanceId } from "./test-slim.js";

describe("IosSimctlDriver device set switch", () => {
  const coreSimulatorRoot = "/Users/me/CoreSimulator";

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
          message: `Refusing the ios device set: Simlock's own set at ${ownRoot} still holds 2 simulator(s) (${first}, ${second}). Set drivers.ios.deviceSet back to simlock, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot} delete <udid>\`.`,
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
          message: `Refusing the ios device set: Simlock's own set at ${ownRoot} still holds 2 simulator(s) (${first}, ${third}). Set drivers.ios.deviceSet back to simlock, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot} delete <udid>\`, or, for a seed in a sources folder, \`xcrun simctl --set ${ownRoot}/sources delete <udid>\`.`,
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
        "default with a seed in the simlock sources folder",
        { deviceSet: "default" },
        async (fs) => {
          await fs.mkdirp(`/home/.simlock/devices/src/${third}`);
        },
        {
          message: `Refusing the ios device set: Simlock's own set at ${ownRoot} still holds 1 simulator(s) (${third}). Set drivers.ios.deviceSet back to simlock, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set ${ownRoot} delete <udid>\`, or, for a seed in a sources folder, \`xcrun simctl --set /home/.simlock/devices/src delete <udid>\`.`,
          path: ownRoot,
          reason: "device-set-changed",
        },
      ],
      [
        "simlock with a seed in the default sources folder",
        { deviceSet: "simlock" },
        async (fs) => {
          await fs.mkdirp(`/home/.simlock/devices/src_____/${second}`);
        },
        {
          message: `Refusing the ios device set: Simlock's sources set at /home/.simlock/devices/src_____ still holds 1 simulator(s) (${second}). Set drivers.ios.deviceSet back to default, run \`simlock nuke --delete-devices\` and \`simlock doctor --purge-orphans\`, then switch again. Delete any that remain with \`xcrun simctl --set /home/.simlock/devices/src_____ delete <udid>\`. Run \`simlock nuke --delete-devices\` again afterwards, so Simlock drops its record of them.`,
          path: "/home/.simlock/devices/src_____",
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

  it.each(["default", "simlock"] as const)(
    "a worker whose %s device set is as long as its home plus 12 characters keeps its own seeds in the sources folder the other setting would share",
    async (deviceSet) => {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/home/.simlock/devices/src/00000000-0000-0000-0000-000000000001");

      const created = IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        clock: new FakeClock(),
        // why: `/Users/me/CoreSim1/Devices` is 26 characters, as long as `/home/.simlock/devices/ios`, so both settings name `/home/.simlock/devices/src`.
        coreSimulatorRoot: "/Users/me/CoreSim1",
        driverConfig: { deviceSet },
        filesystem,
        idGenerator: { generate: () => "device-1" },
        instanceId,
        processRunner: new ScriptedProcessRunner([]),
        simlockHome: "/home/.simlock",
      });

      await expect(created).resolves.toBeInstanceOf(IosSimctlDriver);
    },
  );
});
