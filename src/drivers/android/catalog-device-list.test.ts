import { describe, expect, it } from "vitest";

import { MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import type { ProcessRunner, ScriptedProcessExpectation } from "../../ports/index.js";

import { binaries, androidFilesystem, createPart } from "./test-catalog.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  customDeviceXml,
  pixelDevices,
  processResult,
  writeDevicesXml,
} from "./testing.js";

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Catalog` directly over a memory filesystem and a scripted `avdmanager`.
describe("Catalog", () => {
  describe("avdmanager list device reads", () => {
    const toolsPackage = `${sdk}/cmdline-tools/latest`;
    const sdklibJar = `${toolsPackage}/lib/sdklib/sdklib.core.jar`;
    const userDevicesXml = `${home}/.android/devices.xml`;
    const imageDevicesXml = `${sdk}/system-images/android-34/google_apis/arm64-v8a/devices.xml`;
    const addOnDevicesXml = `${sdk}/add-ons/addon-acme/devices.xml`;
    const extraDirectory = `${sdk}/extras/acme/device_profiles`;
    const extraDevicesXml = `${extraDirectory}/devices.xml`;
    const rereadDevices = `Available devices:\nid: 0 or "reread_phone"\n    Name: Reread Phone\n    OEM : Acme\n`;

    /** why: sdklib reads `extras/<vendor>/<item>/devices.xml` only when the item's source.properties says `Extra.Path=DeviceProfiles`. */
    async function profilesExtra(filesystem: MemoryFilesystem, devicesXml?: string): Promise<void> {
      await filesystem.mkdirp(extraDirectory);
      await filesystem.writeFileAtomic(
        `${extraDirectory}/source.properties`,
        "Pkg.Revision=1\nExtra.Path=DeviceProfiles\n",
      );
      if (devicesXml !== undefined) await filesystem.writeFileAtomic(extraDevicesXml, devicesXml);
    }

    /** why: every input the read is keyed on is present, so a change to any of them is a change, not a creation. */
    async function readsHarness(
      options: {
        readonly avdmanager?: string;
        readonly before?: (filesystem: MemoryFilesystem) => Promise<void>;
        readonly results?: readonly ScriptedProcessExpectation[];
      } = {},
    ) {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${toolsPackage}/lib/sdklib`);
      await filesystem.writeFileAtomic(sdklibJar, "jar");
      await filesystem.writeFileAtomic(`${toolsPackage}/source.properties`, "Pkg.Revision=20.0\n");
      await filesystem.writeFileAtomic(imageDevicesXml, "<d:devices/>");
      await filesystem.mkdirp(`${sdk}/add-ons/addon-acme`);
      await filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices/>");
      await options.before?.(filesystem);
      const avdmanager = options.avdmanager ?? binaries.avdmanager;
      const runner = new ScriptedProcessRunner(
        options.results ?? [
          processResult(avdmanager, ["list", "device"], pixelDevices),
          processResult(avdmanager, ["list", "device"], rereadDevices),
        ],
      );
      const part = createPart(filesystem, runner, { avdmanager });
      const listRuns = () =>
        runner.calls.filter(
          (call) => call.command === avdmanager && call.args.join(" ") === "list device",
        );
      return { part, filesystem, listRuns, runner };
    }

    it("runs `avdmanager list device` once, with a 30 s limit, for two catalogs read while none of its inputs changed", async () => {
      const { part, listRuns } = await readsHarness();

      const first = await part.listCatalog();
      const second = await part.listCatalog();

      expect(first.models).toContain("Pixel 5");
      expect(second.models).toContain("Pixel 5");
      expect(second.models).not.toContain("Reread Phone");
      expect(listRuns()).toHaveLength(1);
      expect(listRuns()[0]?.options.timeoutMs).toBe(30_000);
    });

    it("runs `avdmanager list device` again after any file it reads device profiles from changed", async () => {
      const legacyTools = `${sdk}/tools`;
      const legacyJar = `${legacyTools}/lib/sdklib-26.0.0-dev.jar`;
      const cases: readonly {
        readonly change: string;
        readonly avdmanager?: string;
        readonly before?: (filesystem: MemoryFilesystem) => Promise<void>;
        readonly act: (filesystem: MemoryFilesystem) => Promise<void>;
      }[] = [
        {
          act: async (filesystem) =>
            filesystem.defineAttributes(sdklibJar, { modifiedAtMs: 5_000 }),
          change: "the sdklib jar's modified time",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(sdklibJar, "jar, updated"),
          change: "the sdklib jar's size",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(
              `${toolsPackage}/source.properties`,
              "Pkg.Revision=21.0.1\n",
            ),
          change: "the command-line tools' source.properties",
        },
        {
          act: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Made", 2048)),
          change: "devices.xml created",
        },
        {
          act: async (filesystem) =>
            writeDevicesXml(
              filesystem,
              customDeviceXml("Kept", 2048) + customDeviceXml("New", 2048),
            ),
          before: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Kept", 2048)),
          change: "devices.xml edited",
        },
        {
          act: async (filesystem) => filesystem.rm(userDevicesXml),
          before: async (filesystem) => writeDevicesXml(filesystem, customDeviceXml("Kept", 2048)),
          change: "devices.xml deleted",
        },
        {
          act: async (filesystem) =>
            filesystem.mkdirp(`${sdk}/system-images/android-35/google_apis/arm64-v8a`),
          change: "a system image installed",
        },
        {
          act: async (filesystem) => {
            await filesystem.mkdirp(`${sdk}/system-images/android-36/android-wear/arm64-v8a`);
            await filesystem.writeFileAtomic(
              `${sdk}/system-images/android-36/android-wear/arm64-v8a/devices.xml`,
              "<d:devices/>",
            );
          },
          change: "a system image installed with its own devices.xml",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(imageDevicesXml, "<d:devices></d:devices>"),
          change: "an installed system image's devices.xml",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(addOnDevicesXml, "<d:devices></d:devices>"),
          change: "an add-on's devices.xml",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(extraDevicesXml, "<d:devices/>"),
          before: async (filesystem) => profilesExtra(filesystem),
          change: "an extra's devices.xml created",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(extraDevicesXml, "<d:devices></d:devices>"),
          before: async (filesystem) => profilesExtra(filesystem, "<d:devices/>"),
          change: "an extra's devices.xml edited",
        },
        {
          act: async (filesystem) => filesystem.rm(extraDevicesXml),
          before: async (filesystem) => profilesExtra(filesystem, "<d:devices/>"),
          change: "an extra's devices.xml removed",
        },
        {
          act: async (filesystem) =>
            filesystem.writeFileAtomic(
              `${extraDirectory}/source.properties`,
              "Extra.Path=DeviceProfiles\n",
            ),
          before: async (filesystem) => {
            await profilesExtra(filesystem, "<d:devices/>");
            await filesystem.writeFileAtomic(
              `${extraDirectory}/source.properties`,
              "Extra.Path=usb_driver\n",
            );
          },
          change: "an extra's source.properties made it a device-profiles extra",
        },
        {
          act: async (filesystem) => filesystem.writeFileAtomic(legacyJar, "legacy jar, updated"),
          avdmanager: `${legacyTools}/bin/avdmanager`,
          before: async (filesystem) => {
            await filesystem.rm(toolsPackage);
            await filesystem.mkdirp(`${legacyTools}/bin`);
            await filesystem.writeFileAtomic(`${legacyTools}/bin/avdmanager`, "binary");
            await filesystem.writeFileAtomic(`${legacyTools}/bin/sdkmanager`, "binary");
            await filesystem.mkdirp(`${legacyTools}/lib`);
            await filesystem.writeFileAtomic(legacyJar, "legacy jar");
          },
          change: "the legacy tools' sdklib jar",
        },
      ];

      const seen: Record<string, readonly unknown[]> = {};
      for (const row of cases) {
        const { part, filesystem, listRuns } = await readsHarness({
          ...(row.avdmanager === undefined ? {} : { avdmanager: row.avdmanager }),
          ...(row.before === undefined ? {} : { before: row.before }),
        });
        const first = await part.listCatalog();
        await row.act(filesystem);
        const second = await part.listCatalog();
        seen[row.change] = [
          first.models.includes("Reread Phone"),
          second.models.includes("Reread Phone"),
          listRuns().length,
        ];
      }

      expect(seen).toEqual(Object.fromEntries(cases.map((row) => [row.change, [false, true, 2]])));
    });

    it("runs `avdmanager list device` again after a read that failed", async () => {
      const { part, listRuns } = await readsHarness({
        results: [
          {
            match: { args: ["list", "device"], command: binaries.avdmanager },
            result: { code: 1, stderr: "Error: could not read device definitions", stdout: "" },
          },
          processResult(binaries.avdmanager, ["list", "device"], rereadDevices),
        ],
      });

      await expect(part.listCatalog()).rejects.toThrow("could not read device definitions");
      const catalog = await part.listCatalog();

      expect(catalog.models).toContain("Reread Phone");
      expect(listRuns()).toHaveLength(2);
    });

    it("runs one `avdmanager list device` for two catalogs read at once", async () => {
      const scripted = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // why: the run stays in flight until both catalogs have asked, so the second cannot be served from a finished read.
      const runner: ProcessRunner = {
        run: async (command, args, options) => {
          await held;
          return scripted.run(command, args, options);
        },
        spawn: (command, args, options) => scripted.spawn(command, args, options),
        spawnStreaming: (command, args, options) => scripted.spawnStreaming(command, args, options),
      };
      const part = createPart(await androidFilesystem(), runner);

      const catalogs = Promise.allSettled([part.listCatalog(), part.listCatalog()]);
      // why: the filesystem fake settles in microtasks, so one macrotask lets both catalogs
      // reach the read before the first run ends.
      await new Promise((resolve) => setImmediate(resolve));
      release();

      expect(
        (await catalogs).map(
          (catalog) => catalog.status === "fulfilled" && catalog.value.models.includes("Pixel 5"),
        ),
      ).toEqual([true, true]);
      expect(scripted.calls.filter((call) => call.args.join(" ") === "list device")).toHaveLength(
        1,
      );
    });
  });
});
