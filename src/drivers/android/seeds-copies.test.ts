import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  MemoryFilesystem,
  type ProcessResult,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";

import { createPart, sources, seedHome, seedHarness } from "./test-seeds.js";
import {
  ANDROID_SDK_ROOT as sdk,
  avdDirectory,
  binaries,
  bootingAt,
  bootProbes,
  EmulatorExitingRunner,
  makingASeedFrom,
  makingTheSeed,
  ok,
  pixelDevices,
  processResult,
  seedEmulatorLine,
  seedStages,
  writeSeedFiles,
} from "./testing.js";

const copyHome = `${avdDirectory}/simlock_one`;

/** why: the daemon after a restart: a new part over the same device folders and the same source table. */
function reopened(
  harness: Awaited<ReturnType<typeof seedHarness>>,
  expectations: readonly ScriptedProcessExpectation[],
  options: { readonly clock?: FakeClock; readonly seedLaunchInputs?: readonly string[] } = {},
) {
  const runner = new EmulatorExitingRunner([...expectations]);
  const part = createPart(harness.filesystem, runner, {
    ...options,
    database: harness.database,
    ids: ["four", "five", "six"],
  });
  return { ...part, runner };
}

/**
 * why: a cold-booted guest brings its cellular data call up a while after boot completes (#1631):
 * `dumpsys connectivity` reports no default network twice, then network 100. It notes the default
 * network the guest last reported when the boot snapshot was saved.
 */
class DataCallRunner extends EmulatorExitingRunner {
  readonly #answers = ["none", "none", "100"];
  #reported: string | undefined;
  defaultNetworkAtSave: string | undefined;

  override run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    const line = args.join(" ");
    if (command === binaries.adb && line.endsWith("shell dumpsys connectivity")) {
      this.#reported = this.#answers.length > 1 ? this.#answers.shift() : this.#answers[0];
      return Promise.resolve(
        ok(`NetworkProviders for:\n  Telephony\n\nActive default network: ${this.#reported}\n`),
      );
    }
    if (line.endsWith("emu avd snapshot save simlock_boot")) {
      this.defaultNetworkAtSave = this.#reported ?? "never read";
    }
    return super.run(command, args, options);
  }
}

class SizeFailureFilesystem extends MemoryFilesystem {
  override directorySize(): Promise<number> {
    return Promise.reject(new Error("EIO"));
  }
}

class CopyFailureFilesystem extends MemoryFilesystem {
  readonly #message: string;

  constructor(message: string) {
    super();
    this.#message = message;
  }

  override copyTree(): Promise<void> {
    return Promise.reject(new Error(this.#message));
  }
}

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Seeds` directly over a memory filesystem and a scripted runner, with the real parts it takes.
describe("Seeds", () => {
  describe("seeds and copies", () => {
    it("makes one seed when two plain leases of one kind are provisioned at once", async () => {
      const madeHome = `${sources}/seed_three`;
      const harness = await seedHarness([
        ...makingTheSeed(madeHome),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await writeSeedFiles(harness.filesystem, madeHome);

      const [first, second] = await Promise.all([
        harness.seeds.provision(harness.spec),
        harness.seeds.provision(harness.spec),
      ]);

      expect(harness.runner.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
      expect([first.deviceId, second.deviceId]).toEqual(["simlock_one", "simlock_two"]);
      await expect(
        harness.filesystem.exists(`${avdDirectory}/simlock_two/simlock.avd`),
      ).resolves.toBe(true);
      const listed = await harness.seeds.listSources();
      expect(listed.filter((source) => source.orphan !== true)).toHaveLength(1);
    });

    it("saves a seed's boot snapshot only once the guest reports a default network", async () => {
      const clock = new FakeClock();
      const harness = await seedHarness(
        [
          ...makingTheSeed(),
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ],
        { clock, runnerFor: (script) => new DataCallRunner(script) },
      );

      const making = harness.seeds.provision(harness.spec);
      const made = promiseState(making);
      for (let tick = 0; tick < 300 && made.state === "pending"; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        clock.advance(1_000);
      }

      expect(made.state).toBe("fulfilled");
      await making;
      expect((harness.runner as DataCallRunner).defaultNetworkAtSave).toBe("100");
    });

    it("tells why a seed is stale, cut to 300 characters, and clears the reason when the image and emulator match again", async () => {
      const imagePath = `${sdk}/system-images/android-34/google_apis/arm64-v8a`;
      const packageName = "system-images;android-34;google_apis;arm64-v8a";
      const revision = (number: string) => `Pkg.Revision=${number}\n`;
      const original = "Android emulator version 36.1.9";
      const cases = [
        {
          change: async (filesystem: MemoryFilesystem) =>
            filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("2")),
          emulatorVersion: original,
          mend: async (filesystem: MemoryFilesystem) =>
            filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1")),
          reason: `system image ${packageName} changed from revision 1 to 2`,
        },
        {
          change: async (filesystem: MemoryFilesystem) => filesystem.rm(imagePath),
          emulatorVersion: original,
          mend: async (filesystem: MemoryFilesystem) => {
            await filesystem.mkdirp(imagePath);
            await filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1"));
          },
          reason: `system image ${packageName} is not installed`,
        },
        {
          emulatorVersion: "Android emulator version 36.2.0",
          reason: `emulator changed from ${original} to Android emulator version 36.2.0`,
        },
        {
          emulatorVersion: "v".repeat(400),
          reason: `emulator changed from ${original} to ${"v".repeat(400)}`.slice(0, 300),
        },
        {
          emulatorVersion: original,
          reason: "android.emulator launch settings changed",
          seedLaunchInputs: ["headless=true", "gpu=auto"],
        },
      ] as const;

      for (const stale of cases) {
        const harness = await seedHarness(makingTheSeed());
        await harness.filesystem.writeFileAtomic(`${imagePath}/source.properties`, revision("1"));
        await harness.seeds.provision(harness.spec);
        if ("change" in stale) await stale.change(harness.filesystem);

        const changed = await reopened(
          harness,
          [processResult(binaries.emulator, ["-version"], stale.emulatorVersion)],
          "seedLaunchInputs" in stale ? { seedLaunchInputs: stale.seedLaunchInputs } : {},
        );
        await expect(changed.seeds.listSources()).resolves.toMatchObject([
          { id: "seed_two", staleReason: stale.reason },
        ]);

        if ("mend" in stale) await stale.mend(harness.filesystem);
        const mended = await reopened(harness, [
          processResult(binaries.emulator, ["-version"], original),
        ]);
        const [source] = await mended.seeds.listSources();
        expect(source).toMatchObject({ id: "seed_two" });
        expect(source).not.toHaveProperty("staleReason");
      }
    });

    it("destroys a stale seed and makes it again at the next provision", async () => {
      const harness = await seedHarness(makingTheSeed());
      await harness.seeds.provision(harness.spec);
      const newHome = `${sources}/seed_five`;
      await writeSeedFiles(harness.filesystem, newHome);
      const newer = "Android emulator version 36.2.0";
      const later = await reopened(harness, [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.emulator, ["-version"], newer),
        ...makingTheSeed(newHome, newer),
        processResult(binaries.emulator, ["-version"], newer),
      ]);

      await later.seeds.provision(harness.spec);

      expect(await harness.filesystem.exists(seedHome)).toBe(false);
      expect(later.runner.calls.filter((call) => call.args[0] === "create")).toHaveLength(1);
      await expect(later.seeds.listSources()).resolves.toMatchObject([{ id: "seed_five" }]);
    });

    it("removes a seed's folder and row and throws when making it fails at any step", async () => {
      const stage = seedStages();
      const serial = "emulator-5586";
      const neverReady = [
        stage.devices,
        bootingAt(seedHome, ["-no-snapshot-load"], true)[0],
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          "0\n",
        ),
      ] as ScriptedProcessExpectation[];
      const stuckOff = [
        stage.devices,
        ...bootingAt(seedHome, ["-no-snapshot-load"], true),
        stage.sync,
        stage.powerOff,
        stage.probe,
        stage.kill,
      ];
      const cases = [
        {
          expectations: [
            stage.version,
            { ...stage.create, result: { code: 1, stderr: "no such package", stdout: "" } },
          ],
          message: "no such package",
        },
        {
          advance: 300_000,
          expectations: [stage.version, stage.create, ...neverReady],
          message: "Timed out waiting for device to boot",
        },
        {
          advance: 60_000,
          expectations: [stage.version, stage.create, ...stuckOff],
          killsEmulator: true,
          message: "Android seed seed_two did not power off within 60000ms",
        },
        {
          expectations: [
            stage.version,
            stage.create,
            stage.devices,
            ...stage.firstBoot,
            stage.sync,
            stage.powerOff,
            ...bootingAt(seedHome, ["-no-snapshot-load"], true),
            { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
          ],
          message: "Android seed seed_two: boot snapshot simlock_boot was not saved",
        },
        {
          expectations: [
            stage.version,
            stage.create,
            stage.devices,
            ...stage.firstBoot,
            stage.sync,
            stage.powerOff,
            ...bootingAt(seedHome, ["-no-snapshot-load"], true),
            stage.save,
            processResult(binaries.adb, ["-s", serial, "emu", "avd", "snapshot", "list"], "\n"),
            stage.probe,
            stage.kill,
          ],
          message: "Android seed seed_two: boot snapshot simlock_boot was not saved",
        },
      ] as const;

      for (const failing of cases) {
        const clock = new FakeClock();
        const harness = await seedHarness(failing.expectations, { clock });
        // why: the stuck seed's emulator ignores `reboot -p`; only the 60 s deadline ends the wait.
        harness.runner.ignoresEmuKill = "killsEmulator" in failing;
        const provisioning = harness.seeds.provision(harness.spec);
        const outcome = expect(provisioning).rejects.toThrow(failing.message);
        if ("advance" in failing) {
          await vi.waitFor(() =>
            expect(
              harness.runner.calls.some(
                (call) => call.args.includes("sys.boot_completed") || call.args.includes("reboot"),
              ),
            ).toBe(true),
          );
          clock.advance(failing.advance);
        }
        await outcome;

        if ("killsEmulator" in failing) {
          expect(
            harness.runner.calls.some((call) => call.args.includes("kill")),
            "the seed's emulator was asked to quit by its path",
          ).toBe(true);
        }
        const emulators = harness.runner.calls.flatMap((call, index) =>
          call.args.includes("-avd") ? [index] : [],
        );
        for (const emulator of emulators) {
          let exited = false;
          void harness.runner.handles[emulator]?.wait().then(() => {
            exited = true;
          });
          await vi.waitFor(() => expect(exited, "the seed's emulator was killed").toBe(true));
        }
        expect(await harness.filesystem.exists(seedHome)).toBe(false);
        await expect(harness.seeds.listSources()).resolves.toEqual([]);
        expect(harness.database.prepare("SELECT 1 FROM android_source_data").all()).toEqual([]);
      }
    });

    it("removes the device's folder and throws when copying the seed fails", async () => {
      const harness = await seedHarness(makingTheSeed(), {
        filesystem: new CopyFailureFilesystem("cp: no space left on device"),
      });

      await expect(harness.seeds.provision(harness.spec)).rejects.toThrow(
        "copying Android seed seed_two to simlock_one failed: cp: no space left on device",
      );

      expect(await harness.filesystem.exists(copyHome)).toBe(false);
      expect(await harness.filesystem.exists(seedHome)).toBe(true);
    });

    it("provisions a kind with a ready seed while another kind's seed is being made, and leaves that kind's making row and folder alone", async () => {
      const makingHome = `${sources}/seed_device-4`;
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        // why: the other kind's make never gets past its first boot: its emulator never says it booted.
        ...makingASeedFrom(makingHome).slice(0, 3),
        {
          hangs: true,
          match: {
            args: ["-avd", "simlock", ...seedEmulatorLine, "-no-snapshot-load"],
            command: binaries.emulator,
          },
        },
        {
          hangs: true,
          match: {
            args: ["-s", "emulator-5586", "shell", "getprop", "sys.boot_completed"],
            command: binaries.adb,
          },
        },
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await harness.seeds.provision(harness.spec);
      await harness.filesystem.mkdirp(
        `${sdk}/system-images/android-34/google_apis_playstore/arm64-v8a`,
      );
      await writeSeedFiles(harness.filesystem, makingHome);
      const otherKind = await harness.catalog.resolveSpec({
        imageTag: "google_apis_playstore",
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      void harness.seeds.provision(otherKind).catch(() => undefined);
      await vi.waitFor(() => expect(bootProbes(harness.runner)).toBeGreaterThan(2));

      let settled = false;
      const provisioning = harness.seeds.provision(harness.spec).finally(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(settled, "the kind with a ready seed waited for the other kind's make").toBe(true),
      );
      const second = await provisioning;

      expect(second.driverData).toMatchObject({ avdHome: expect.stringContaining("/simlock_") });
      expect(
        harness.database.prepare("SELECT state FROM android_source_data ORDER BY state").all(),
      ).toEqual([{ state: "making" }, { state: "ready" }]);
      expect(await harness.filesystem.exists(makingHome)).toBe(true);

      // why: after a restart that row is another process's leftover, which only its own kind's make or a listing sweeps.
      const restarted = await reopened(harness, [
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
      ]);
      await restarted.seeds.provision(
        await restarted.catalog.resolveSpec({
          model: "Pixel 5",
          osVersion: "34",
          platform: "android",
        }),
      );
      expect(
        harness.database.prepare("SELECT state FROM android_source_data ORDER BY state").all(),
      ).toEqual([{ state: "making" }, { state: "ready" }]);
      expect(await harness.filesystem.exists(makingHome)).toBe(true);
    });

    it("lists each ready seed with its size, reports a sources folder no row names as an orphan, and destroys a source by id after stopping its emulator by path", async () => {
      const serial = "emulator-5586";
      const orphanHome = `${sources}/seed_orphan`;
      const harness = await seedHarness([
        ...makingTheSeed(),
        processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        processResult(binaries.adb, ["devices"], `List of devices attached\n${serial}\tdevice\n`),
        seedStages().probe,
        seedStages().kill,
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await harness.seeds.provision(harness.spec);
      await writeSeedFiles(harness.filesystem, orphanHome);

      await expect(harness.seeds.listSources()).resolves.toEqual([
        {
          id: "seed_two",
          imageTag: "google_apis",
          kind: "seed",
          model: "Pixel 5",
          osVersion: "34",
          sizeBytes: 16,
        },
        { id: "seed_orphan", kind: "seed", model: "unknown", orphan: true, osVersion: "unknown" },
      ]);
      expect(await harness.filesystem.exists(orphanHome)).toBe(true);

      const callsBefore = harness.runner.calls.length;
      await harness.seeds.destroySource("seed_orphan");
      await harness.seeds.destroySource("seed_two");

      expect(await harness.filesystem.exists(`${sources}/seed_two`)).toBe(false);
      expect(await harness.filesystem.exists(orphanHome)).toBe(false);
      expect(
        harness.runner.calls
          .slice(callsBefore)
          .filter((call) => call.args.includes("kill"))
          .map((call) => call.args),
        "the running emulator of the source is found by its path and stopped before its folder goes",
      ).toEqual([["-s", serial, "emu", "kill"]]);
      await expect(harness.seeds.destroySource("seed_two")).rejects.toThrow(
        "Android keeps no source seed_two",
      );
    });

    it("lists no size for a seed whose size cannot be counted", async () => {
      const filesystem = new SizeFailureFilesystem();
      const harness = await seedHarness(
        [
          ...makingTheSeed(),
          processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
        ],
        { filesystem },
      );
      await harness.seeds.provision(harness.spec);

      const [seed] = await harness.seeds.listSources();

      expect(seed).toMatchObject({ id: "seed_two" });
      expect(seed).not.toHaveProperty("sizeBytes");
    });

    it("sweeps a making row an earlier process left, stopping its emulator by path, and one this process has been making past the larger of 900 s and twice android.bootTimeoutMs plus 600 s, and leaves any other this process is making", async () => {
      const serial = "emulator-5586";
      const clock = new FakeClock();
      const stage = seedStages();
      const harness = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          stage.firstBoot[0] as ScriptedProcessExpectation,
          processResult(
            binaries.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            "0\n",
          ),
        ],
        { clock },
      );
      const making = harness.seeds.provision(harness.spec);
      const failed = expect(making).rejects.toThrow("Timed out waiting for device to boot");
      await vi.waitFor(() =>
        expect(harness.runner.calls.some((call) => call.args.includes("sys.boot_completed"))).toBe(
          true,
        ),
      );

      await expect(harness.seeds.listSources()).resolves.toEqual([]);
      expect(await harness.filesystem.exists(seedHome)).toBe(true);

      const restarted = await reopened(harness, [
        processResult(binaries.adb, ["devices"], `List of devices attached\n${serial}\tdevice\n`),
        stage.probe,
        stage.kill,
        processResult(binaries.adb, ["devices"], "List of devices attached\n"),
      ]);
      await expect(restarted.seeds.listSources()).resolves.toEqual([]);
      expect(await harness.filesystem.exists(seedHome)).toBe(false);
      clock.advance(300_000);
      await failed;

      const slowClock = new FakeClock();
      const slow = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          stage.firstBoot[0] as ScriptedProcessExpectation,
          processResult(
            binaries.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            "0\n",
          ),
          processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ],
        { bootTimeoutMs: 600_000, clock: slowClock },
      );
      const slowMaking = slow.seeds.provision(slow.spec);
      const slowFailed = expect(slowMaking).rejects.toThrow();
      await vi.waitFor(() =>
        expect(slow.runner.calls.some((call) => call.args.includes("sys.boot_completed"))).toBe(
          true,
        ),
      );
      const ageTo = (ageMs: number) =>
        slow.database
          .prepare("UPDATE android_source_data SET created_at = ?")
          .run(slowClock.now() - ageMs);

      ageTo(1_000_000);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(true);

      ageTo(1_800_000);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(true);

      ageTo(1_800_001);
      await slow.seeds.listSources();
      expect(await slow.filesystem.exists(seedHome)).toBe(false);
      slowClock.advance(600_000);
      await slowFailed;

      const quickClock = new FakeClock();
      const quick = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          stage.firstBoot[0] as ScriptedProcessExpectation,
          processResult(
            binaries.adb,
            ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            "0\n",
          ),
          processResult(binaries.adb, ["devices"], "List of devices attached\n"),
        ],
        { bootTimeoutMs: 60_000, clock: quickClock },
      );
      const quickMaking = quick.seeds.provision(quick.spec);
      const quickFailed = expect(quickMaking).rejects.toThrow();
      await vi.waitFor(() =>
        expect(quick.runner.calls.some((call) => call.args.includes("sys.boot_completed"))).toBe(
          true,
        ),
      );
      const quickAgeTo = (ageMs: number) =>
        quick.database
          .prepare("UPDATE android_source_data SET created_at = ?")
          .run(quickClock.now() - ageMs);

      // why: twice 60 s plus 600 s is 720 s, under the 900 s floor, which then decides.
      quickAgeTo(900_000);
      await quick.seeds.listSources();
      expect(await quick.filesystem.exists(seedHome)).toBe(true);

      quickAgeTo(900_001);
      await quick.seeds.listSources();
      expect(await quick.filesystem.exists(seedHome)).toBe(false);
      quickClock.advance(60_000);
      await quickFailed;
    });
  });
});
