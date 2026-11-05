import { describe, expect, it } from "vitest";

import { MemoryFilesystem, ScriptedProcessRunner, FakeClock } from "../../ports/index.js";
import type { ProcessRunner } from "../../ports/index.js";
import { AndroidLicenseNotAcceptedError, SystemImages } from "./system-images.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  InstallReflectingProcessRunner,
  processResult,
  userAvd,
} from "./testing.js";

const avdDirectory = `${home}/.simlock/devices/android`;
const sdkmanager = `${sdk}/cmdline-tools/latest/bin/sdkmanager`;

async function androidFilesystem(
  options: { readonly images?: readonly (readonly [string, string, string])[] } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  for (const directory of ["emulator", "platform-tools", "cmdline-tools/latest/bin"]) {
    await filesystem.mkdirp(`${sdk}/${directory}`);
  }
  for (const [api, tag, abi] of options.images ?? [["34", "google_apis", "arm64-v8a"]]) {
    await filesystem.mkdirp(`${sdk}/system-images/android-${api}/${tag}/${abi}`);
  }
  return filesystem;
}

function createPart(
  filesystem: MemoryFilesystem,
  processRunner: ProcessRunner,
  options: {
    readonly acceptAndroidLicenses?: boolean;
    /** why: `ANDROID_AVD_HOME` in the environment the daemon started with; the user's home by default. */
    readonly avdHome?: string;
    readonly sdkmanager?: string;
  } = {},
): SystemImages {
  return new SystemImages({
    acceptAndroidLicenses: options.acceptAndroidLicenses ?? false,
    clock: new FakeClock(),
    deviceRoot: avdDirectory,
    filesystem,
    hostAbi: "arm64-v8a",
    legacyAvdHome: options.avdHome ?? `${home}/.android/avd`,
    processRunner,
    sdk: {
      adb: `${sdk}/platform-tools/adb`,
      emulator: `${sdk}/emulator/emulator`,
      root: sdk,
      sdkmanager: options.sdkmanager ?? sdkmanager,
    },
  });
}

function installFor(
  part: SystemImages,
  component: string,
  options: { onProgress?: (progress: unknown) => void; signal?: AbortSignal } = {},
) {
  return part.installComponent(component, {
    onProgress: options.onProgress ?? (() => undefined),
    signal: options.signal ?? new AbortController().signal,
  });
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `SystemImages` directly over a memory filesystem and a scripted `sdkmanager`.
describe("SystemImages", () => {
  describe("Android SDK license handling", () => {
    const licenseNotAcceptedOutput =
      "Warning: License for package Android SDK Platform 35 not accepted.\n\n" +
      "1 package(s) were skipped due to license issues. Please accept the license(s) and try " +
      "again.\nTo resolve, run: sdkmanager --licenses\n";

    it("fails naming downloads.acceptAndroidLicenses when licenses are unaccepted and the flag is off", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
        },
      ]);
      const part = createPart(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await installFor(part, "35").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AndroidLicenseNotAcceptedError);
      expect((error as Error).message).toContain("downloads.acceptAndroidLicenses");
      expect((error as Error).message).toContain("sdkmanager --licenses");
    });

    it("recognizes the alternate 'licenses have not been accepted' sdkmanager phrasing, not just 'not accepted'", async () => {
      // why: The two documented sdkmanager phrasings this part's license detection claims to
      // handle (see the comment on `hasUnacceptedLicense`): a per-package warning ("... not
      // accepted.") and this one, an aggregate summary with "been" between "not" and "accepted".
      const licensesHaveNotBeenAcceptedOutput =
        "1 of 7 SDK package license(s) not accepted.\n" +
        "Review licenses that have not been accepted (see above)\n" +
        "The licenses have not been accepted.\n";
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licensesHaveNotBeenAcceptedOutput },
        },
      ]);
      const part = createPart(filesystem, runner, { acceptAndroidLicenses: false });

      const error = await installFor(part, "35").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AndroidLicenseNotAcceptedError);
    });

    it("still fails when the install is rejected again after accepting licenses", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: sdkmanager,
          },
          result: { code: 1, stderr: "", stdout: licenseNotAcceptedOutput },
        },
        processResult(sdkmanager, ["--licenses"], "All licenses accepted.\n"),
        {
          match: {
            args: ["--install", "system-images;android-35;google_apis;arm64-v8a"],
            command: sdkmanager,
          },
          result: { code: 1, stderr: "still refusing", stdout: "" },
        },
      ]);
      const part = createPart(filesystem, runner, { acceptAndroidLicenses: true });

      await expect(installFor(part, "35")).rejects.toMatchObject({ name: "DriverCrashError" });
    });
  });

  describe("component install", () => {
    const package35 = "system-images;android-35;google_apis;arm64-v8a";

    it("installs the google_apis image for the host ABI with no timeout of its own, and reports it installed with its package, revision and stamp", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [processResult(sdkmanager, ["--install", package35])],
        filesystem,
      );
      const part = createPart(filesystem, runner);

      const result = await installFor(part, "35");

      expect(result).toEqual({
        outcome: "installed",
        receipt: { package: package35, revision: "1", stamp: expect.stringMatching(/^.+@\d+$/) },
        version: "35",
      });
      expect(runner.calls.find((call) => call.args[0] === "--install")?.options).toEqual({
        lineEnd: "carriage-return-too",
      });
    });

    it("reports already-installed when the image was there before sdkmanager ran", async () => {
      const filesystem = await androidFilesystem({
        images: [["35", "google_apis", "arm64-v8a"]],
      });
      const runner = new ScriptedProcessRunner([
        processResult(sdkmanager, ["--install", package35]),
      ]);
      const part = createPart(filesystem, runner);

      await expect(installFor(part, "35")).resolves.toMatchObject({
        outcome: "already-installed",
        version: "35",
      });
    });

    it("gives two installs of one package, with an uninstall between them, different receipts", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(sdkmanager, ["--install", package35]),
          processResult(sdkmanager, ["--install", package35]),
        ],
        filesystem,
      );
      const part = createPart(filesystem, runner);

      const first = await installFor(part, "35");
      await filesystem.rm(`${sdk}/system-images/android-35`);
      const second = await installFor(part, "35");

      expect(first.outcome).toBe("installed");
      expect(second.outcome).toBe("installed");
      expect(second.receipt).not.toEqual(first.receipt);
    });

    it("fails when sdkmanager exits 0 but the image is still not installed", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        processResult(sdkmanager, ["--install", package35]),
      ]);
      const part = createPart(filesystem, runner);

      const error = await installFor(part, "35").catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        message: expect.stringContaining(`${package35} is still not installed`),
        name: "DriverCrashError",
      });
    });

    it("fails with sdkmanager's own output when the install is rejected outright", async () => {
      const filesystem = await androidFilesystem();
      const runner = new ScriptedProcessRunner([
        {
          match: { args: ["--install", package35], command: sdkmanager },
          result: { code: 1, stderr: "no network", stdout: "" },
        },
      ]);
      const part = createPart(filesystem, runner);

      await expect(installFor(part, "35")).rejects.toMatchObject({
        message: expect.stringContaining("no network"),
        name: "DriverCrashError",
      });
    });

    it("reports each percentage sdkmanager prints as progress, and nothing for a line without one", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          {
            ...processResult(sdkmanager, ["--install", package35]),
            stdoutLines: [
              "[=====      ] 25% Downloading x86_64-35_r09.zip...",
              "Unzipping",
              "[===========] 100% Unzipping...",
            ],
          },
        ],
        filesystem,
      );
      const part = createPart(filesystem, runner);
      const progress: unknown[] = [];

      await installFor(part, "35", { onProgress: (report) => progress.push(report) });

      expect(progress).toEqual([
        { percent: 25, stage: "downloading" },
        { percent: 100, stage: "downloading" },
      ]);
    });

    it.each([
      ["the install", ["--install", package35]],
      ["the license step", ["--licenses"]],
    ] as const)("ends %s when the signal fires, and fails the install", async (_step, hanging) => {
      const filesystem = await androidFilesystem();
      const licenseRefusal = {
        match: { args: ["--install", package35], command: sdkmanager },
        result: {
          code: 1,
          stderr: "",
          stdout: "Warning: License for package Android SDK Platform 35 not accepted.\n",
        },
      };
      const runner = new ScriptedProcessRunner([
        ...(hanging[0] === "--licenses" ? [licenseRefusal] : []),
        { hangs: true, match: { args: [...hanging], command: sdkmanager } },
      ]);
      const part = createPart(filesystem, runner, { acceptAndroidLicenses: true });
      const controller = new AbortController();

      let error: unknown;
      void installFor(part, "35", { signal: controller.signal }).catch((caught: unknown) => {
        error = caught;
      });
      const spawned = hanging[0] === "--licenses" ? 2 : 1;
      for (let tick = 0; tick < 100 && runner.handles.length < spawned; tick += 1) {
        await Promise.resolve();
      }
      expect(runner.handles).toHaveLength(spawned);
      controller.abort();
      for (let tick = 0; tick < 50 && error === undefined; tick += 1) {
        await Promise.resolve();
      }

      // why: Settled within a few microtasks of the signal: the kill ended it, not a timer.
      expect(error).toMatchObject({
        message: expect.stringContaining("was ended before it finished"),
        name: "DriverCrashError",
      });
    });

    it("finds the image an API level means with its receipt, and nothing for a level that is not installed", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.writeFileAtomic(
        `${sdk}/system-images/android-34/google_apis/arm64-v8a/source.properties`,
        "Pkg.Revision=7\n",
      );
      const runner = new ScriptedProcessRunner([]);
      const part = createPart(filesystem, runner);

      await expect(part.findComponent("34")).resolves.toEqual({
        receipt: {
          package: "system-images;android-34;google_apis;arm64-v8a",
          revision: "7",
          stamp: expect.stringMatching(/^.+@\d+$/),
        },
        version: "34",
      });
      await expect(part.findComponent("35")).resolves.toBeUndefined();
      expect(runner.calls).toEqual([]);
    });
  });

  describe("listComponents()", () => {
    const userAvdHome = `${home}/.android/avd`;
    const googleApis = `${sdk}/system-images/android-35/google_apis/arm64-v8a`;
    const plain = `${sdk}/system-images/android-35/default/arm64-v8a`;

    it("lists two images of one API level as two entries with different variants, each with its directory's size", async () => {
      const filesystem = await androidFilesystem({
        images: [
          ["35", "google_apis", "arm64-v8a"],
          ["35", "default", "arm64-v8a"],
        ],
      });
      await filesystem.writeFileAtomic(`${googleApis}/source.properties`, "Pkg.Revision=7\n");
      await filesystem.mkdirp(`${googleApis}/data`);
      await filesystem.writeFileAtomic(`${googleApis}/data/userdata.img`, "0123456789");
      await filesystem.writeFileAtomic(`${plain}/system.img`, "abc");
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      const listed = await part.listComponents();

      expect(listed).toEqual([
        {
          foreignDevices: 0,
          receipt: {
            package: "system-images;android-35;default;arm64-v8a",
            revision: "unknown",
            stamp: "",
          },
          sizeBytes: 3,
          variant: "default/arm64-v8a",
          version: "35",
        },
        {
          foreignDevices: 0,
          receipt: {
            package: "system-images;android-35;google_apis;arm64-v8a",
            revision: "7",
            stamp: expect.stringMatching(/^.+@\d+$/),
          },
          sizeBytes: "Pkg.Revision=7\n".length + 10,
          variant: "google_apis/arm64-v8a",
          version: "35",
        },
      ]);
    });

    it("counts an AVD in the user's AVD home that names the image as foreign, wherever its directory is, and not an AVD in Simlock's root", async () => {
      const filesystem = await androidFilesystem({
        images: [
          ["35", "google_apis", "arm64-v8a"],
          ["35", "default", "arm64-v8a"],
        ],
      });
      await userAvd(filesystem, "Pixel_8", "system-images/android-35/google_apis/arm64-v8a/");
      await userAvd(filesystem, "Elsewhere", `${googleApis}/`, { avdPath: "/work/Elsewhere.avd" });
      await userAvd(filesystem, "Other", "system-images/android-34/google_apis/arm64-v8a/");
      await userAvd(filesystem, "simlock_one", "system-images/android-35/google_apis/arm64-v8a/", {
        avdHome: avdDirectory,
      });
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      const listed = await part.listComponents();

      expect(listed.map(({ foreignDevices, variant }) => ({ foreignDevices, variant }))).toEqual([
        { foreignDevices: 0, variant: "default/arm64-v8a" },
        { foreignDevices: 2, variant: "google_apis/arm64-v8a" },
      ]);
    });

    it("counts every AVD in the user's AVD home that names the image, booted before or never (#241)", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const sysdir = "system-images/android-35/google_apis/arm64-v8a/";
      await userAvd(filesystem, "Fresh", sysdir);
      await userAvd(filesystem, "Booted", sysdir);
      await filesystem.writeFileAtomic(`${userAvdHome}/Booted.avd/userdata-qemu.img`, "data");
      await filesystem.writeFileAtomic(`${userAvdHome}/Booted.avd/hardware-qemu.ini`, "hw\n");
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      const listed = await part.listComponents();

      expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([2]);
    });

    it("finds an AVD beside a pointer file with an empty path, counts nothing for an AVD whose directory is gone, and still lists the image", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      const sysdir = "system-images/android-35/google_apis/arm64-v8a/";
      await userAvd(filesystem, "Beside", sysdir);
      await filesystem.writeFileAtomic(
        `${userAvdHome}/Beside.ini`,
        "avd.ini.encoding=UTF-8\npath=\n",
      );
      await filesystem.writeFileAtomic(`${userAvdHome}/Gone.ini`, "path=/nowhere/Gone.avd\n");
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      const listed = await part.listComponents();

      expect(listed.map(({ foreignDevices, version }) => ({ foreignDevices, version }))).toEqual([
        { foreignDevices: 1, version: "35" },
      ]);
    });

    it("counts no foreign AVD when the user's AVD home is Simlock's own root, as in a daemon started from a lease's environment", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      await userAvd(filesystem, "simlock_one", "system-images/android-35/google_apis/arm64-v8a/", {
        avdHome: avdDirectory,
      });
      const part = createPart(filesystem, new ScriptedProcessRunner([]), {
        avdHome: avdDirectory,
      });

      const listed = await part.listComponents();

      expect(listed.map(({ foreignDevices }) => foreignDevices)).toEqual([0]);
    });

    it.each([
      ["the user's AVD home", () => userAvdHome],
      ["an AVD's pointer file", () => `${userAvdHome}/Locked.ini`],
      ["an AVD's config.ini", () => `${userAvdHome}/Locked.avd/config.ini`],
    ])(
      "rejects when %s cannot be read, rather than count the AVDs there as using nothing",
      async (_label, unreadable) => {
        const filesystem = await androidFilesystem({
          images: [["35", "google_apis", "arm64-v8a"]],
        });
        await userAvd(filesystem, "Locked", "system-images/android-35/google_apis/arm64-v8a/");
        filesystem.defineFailure(unreadable(), "EACCES");
        const part = createPart(filesystem, new ScriptedProcessRunner([]));

        await expect(part.listComponents()).rejects.toMatchObject({ code: "EACCES" });
      },
    );

    it("leaves sizeBytes out when the image directory cannot be read, and still lists the image", async () => {
      const filesystem = await androidFilesystem({ images: [["35", "google_apis", "arm64-v8a"]] });
      await filesystem.writeFileAtomic(`${googleApis}/system.img`, "abc");
      filesystem.defineFailure(`${googleApis}/system.img`, "EACCES");
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      const listed = await part.listComponents();

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ variant: "google_apis/arm64-v8a", version: "35" });
      expect(listed[0]).not.toHaveProperty("sizeBytes");
    });

    it("lists an image with the receipt installComponent returned for it, and starts no process to list", async () => {
      const filesystem = await androidFilesystem();
      const runner = new InstallReflectingProcessRunner(
        [
          processResult(sdkmanager, [
            "--install",
            "system-images;android-35;google_apis;arm64-v8a",
          ]),
        ],
        filesystem,
      );
      const part = createPart(filesystem, runner);
      const installed = await installFor(part, "35");
      const callsBeforeListing = runner.calls.length;

      const listed = await part.listComponents();

      expect(listed.find((component) => component.version === "35")?.receipt).toEqual(
        installed.receipt,
      );
      expect(runner.calls).toHaveLength(callsBeforeListing);
    });
  });

  describe("toolVersions()", () => {
    it("reports emulator, platform-tools, and command-line tools revisions from each package's source.properties", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.writeFileAtomic(
        `${sdk}/emulator/source.properties`,
        "Pkg.Desc=Android Emulator\nPkg.Revision=35.4.9\n",
      );
      await filesystem.writeFileAtomic(
        `${sdk}/platform-tools/source.properties`,
        "Pkg.Revision=36.0.0\nPkg.Path=platform-tools\n",
      );
      await filesystem.writeFileAtomic(
        `${sdk}/cmdline-tools/latest/source.properties`,
        "Pkg.Revision=19.0\n",
      );
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      await expect(part.toolVersions()).resolves.toEqual([
        { name: "emulator", version: "35.4.9" },
        { name: "platform-tools", version: "36.0.0" },
        { name: "cmdline-tools", version: "19.0" },
      ]);
    });

    it("names the legacy SDK tools package as tools when its sdkmanager is the one in use", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${sdk}/tools`);
      await filesystem.writeFileAtomic(`${sdk}/tools/source.properties`, "Pkg.Revision=26.1.1\n");
      const part = createPart(filesystem, new ScriptedProcessRunner([]), {
        sdkmanager: `${sdk}/tools/bin/sdkmanager`,
      });

      await expect(part.toolVersions()).resolves.toEqual([{ name: "tools", version: "26.1.1" }]);
    });

    it("omits a tool whose source.properties cannot be read", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.writeFileAtomic(
        `${sdk}/emulator/source.properties`,
        "Pkg.Revision=35.4.9\n",
      );
      await filesystem.writeFileAtomic(
        `${sdk}/cmdline-tools/latest/source.properties`,
        "Pkg.Desc=Android SDK Command-line Tools\nPkg.Revision=\n",
      );
      const part = createPart(filesystem, new ScriptedProcessRunner([]));

      await expect(part.toolVersions()).resolves.toEqual([{ name: "emulator", version: "35.4.9" }]);
    });
  });
});
