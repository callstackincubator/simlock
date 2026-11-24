import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  MemoryFilesystem,
  NoopLogger,
  type Logger,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";

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

class SizeFailureFilesystem extends MemoryFilesystem {
  override directorySize(): Promise<number> {
    return Promise.reject(new Error("EIO"));
  }
}

/** why: free space per volume, so a reservation on the wrong volume is seen: only the device root is short, every other path has room. */
class CopyRecordingFilesystem extends MemoryFilesystem {
  readonly copies: string[] = [];
  readonly volumesAsked: string[] = [];
  readonly #deviceRootFree: number;
  #failuresLeft: number;
  #gate: Promise<void> | undefined;
  #onCopyStarted: (() => void) | undefined;

  constructor(deviceRootFree: number, failFirstCopies = 0) {
    super();
    this.#deviceRootFree = deviceRootFree;
    this.#failuresLeft = failFirstCopies;
  }

  override diskFree(path: string): Promise<number> {
    this.volumesAsked.push(path);
    return Promise.resolve(path === avdDirectory ? this.#deviceRootFree : Number.MAX_SAFE_INTEGER);
  }

  /** why: holds every later copy open until the returned function is called, and resolves `started` when one has begun. */
  holdCopies(): { readonly started: Promise<void>; readonly release: () => void } {
    let release = () => {};
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      this.#onCopyStarted = resolve;
    });
    return { started, release };
  }

  override async copyTree(from: string, to: string, options: { readonly timeoutMs: number }) {
    this.copies.push(to);
    this.#onCopyStarted?.();
    await this.#gate;
    if (this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      throw new Error("cp: interrupted");
    }
    return super.copyTree(from, to, options);
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

/** why: Windows refuses to delete a file a process still holds; a killed emulator's qemu child holds the seed's disks for a moment after the kill (#1700). */
class BusySeedFilesystem extends MemoryFilesystem {
  override async rm(path: string): Promise<void> {
    if (path === seedHome) {
      const error = new Error(
        `EBUSY: resource busy or locked, unlink '${seedHome}/simlock.avd/cache.img'`,
      ) as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
    await super.rm(path);
  }
}

/** why: the order of a delete against an emulator's exit is what a failed make's cleanup depends on on Windows (#1765). */
class RecordingRemovalFilesystem extends MemoryFilesystem {
  readonly removed: string[] = [];

  override async rm(path: string): Promise<void> {
    this.removed.push(path);
    await super.rm(path);
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
          message:
            "Device failed to boot: seed_two: the first boot did not finish within 300000 ms",
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

    it("waits for the seed's emulator to exit after killing it before removing the folder of a failed make (#1765)", async () => {
      const stage = seedStages();
      const filesystem = new RecordingRemovalFilesystem();
      const harness = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          ...stage.firstBoot,
          stage.sync,
          stage.powerOff,
          ...bootingAt(seedHome, ["-no-snapshot-load"], true),
          { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
        ],
        { filesystem },
      );
      let released!: () => void;
      const exitHeld = new Promise<void>((resolve) => {
        released = resolve;
      });
      let boots = 0;
      let killed = false;
      const spawn = harness.runner.spawn.bind(harness.runner);
      harness.runner.spawn = (...call: Parameters<typeof spawn>) => {
        const handle = spawn(...call);
        if (!call[1].includes("-avd") || ++boots !== 2) return handle;
        // why: a real emulator's exit lags its SIGKILL (the qemu child holds the disks); this one exits only when the test lets it.
        return {
          kill: (signal) => {
            killed = true;
            handle.kill(signal);
          },
          pid: handle.pid,
          stderr: handle.stderr,
          stdout: handle.stdout,
          unref: () => handle.unref(),
          wait: () => exitHeld.then(() => handle.wait()),
        };
      };

      const provisioning = harness.seeds.provision(harness.spec);
      const outcome = expect(provisioning).rejects.toThrow("was not saved");
      await vi.waitFor(() => expect(killed, "the seed's emulator was killed").toBe(true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(filesystem.removed, "the folder is not removed while the emulator runs").toEqual([]);

      released();
      await outcome;
      expect(filesystem.removed).toEqual([seedHome]);
    });

    it("throws the make's own error, not the removal's, when a failed seed's folder cannot be removed (#1700)", async () => {
      const stage = seedStages();
      const warnings: { message: string; detail: unknown }[] = [];
      const logger: Logger = new (class extends NoopLogger {
        override warn(message: string, detail?: Record<string, unknown>): void {
          warnings.push({ message, detail });
        }
      })();
      const harness = await seedHarness(
        [
          stage.version,
          stage.create,
          stage.devices,
          ...stage.firstBoot,
          stage.sync,
          stage.powerOff,
          ...bootingAt(seedHome, ["-no-snapshot-load"], true),
          { ...stage.save, result: { code: 1, stderr: "emulator gone", stdout: "" } },
        ],
        { filesystem: new BusySeedFilesystem(), logger },
      );

      await expect(harness.seeds.provision(harness.spec)).rejects.toThrow(
        "Android seed seed_two: boot snapshot simlock_boot was not saved",
      );
      expect(warnings).toEqual([
        {
          message: "android folder was not removed after a failed operation",
          detail: expect.objectContaining({ folder: seedHome }),
        },
      ]);
      expect(
        harness.database.prepare("SELECT state FROM android_source_data").all(),
        "the row stays for the next sweep",
      ).toEqual([{ state: "making" }]);
    });

    it("names the seed and which of its two boots ran out of android.bootTimeoutMs when making a seed times out", async () => {
      const stage = seedStages();
      const serial = "emulator-5586";
      const neverReady = [
        bootingAt(seedHome, ["-no-snapshot-load"], true)[0],
        processResult(
          binaries.adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          "0\n",
        ),
      ] as ScriptedProcessExpectation[];
      const cases = [
        {
          boot: "first boot",
          expectations: [stage.version, stage.create, stage.devices, ...neverReady],
          probesBeforeHang: 1,
        },
        {
          boot: "second boot",
          expectations: [
            stage.version,
            stage.create,
            stage.devices,
            ...stage.firstBoot,
            stage.sync,
            stage.powerOff,
            ...neverReady,
          ],
          probesBeforeHang: 2,
        },
      ] as const;

      for (const failing of cases) {
        const clock = new FakeClock();
        const harness = await seedHarness(failing.expectations, { clock });
        const failure = harness.seeds.provision(harness.spec).catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(
            harness.runner.calls.filter((call) => call.args.includes("sys.boot_completed")),
          ).toHaveLength(failing.probesBeforeHang),
        );
        clock.advance(300_000);

        const error = (await failure) as Error;
        expect(error.name, failing.boot).toBe("BootTimeoutError");
        expect(error.message, failing.boot).toContain("seed_two");
        expect(error.message, failing.boot).toContain(failing.boot);
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

    it("refuses a copy of the seed that does not fit in the device root's free space before copying, and copies one that fits exactly", async () => {
      const seedBytes = 4_112;
      const provisionWith = async (freeBytes: number, failFirstCopies = 0) => {
        const filesystem = new CopyRecordingFilesystem(freeBytes, failFirstCopies);
        const harness = await seedHarness(
          [
            ...makingTheSeed(),
            processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
            processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
            processResult(binaries.emulator, ["-version"], "Android emulator version 36.1.9"),
          ],
          { filesystem },
        );
        await filesystem.mkdirp(`${seedHome}/simlock.avd/snapshots/simlock_boot`);
        await filesystem.writeFileAtomic(
          `${seedHome}/simlock.avd/snapshots/simlock_boot/ram.bin`,
          "x".repeat(4_096),
        );
        return { filesystem, harness, provision: harness.seeds.provision(harness.spec) };
      };

      const fits = await provisionWith(seedBytes);
      await expect(fits.provision).resolves.toMatchObject({ deviceId: "simlock_one" });
      expect(fits.filesystem.copies).toEqual([`${copyHome}/simlock.avd`]);
      // why: a finished copy gives its reservation back, so the next copy of the same size is not refused for it.
      await expect(fits.harness.seeds.provision(fits.harness.spec)).resolves.toMatchObject({
        deviceId: "simlock_three",
      });
      expect(fits.filesystem.copies).toHaveLength(2);
      // why: only the device root's volume is short in this filesystem, so the reservation is shown to be on it.
      expect(new Set(fits.filesystem.volumesAsked)).toEqual(new Set([avdDirectory]));

      // why: two copies at once with room for one: the second is refused while the first runs, and goes through once it ends.
      const crowded = await provisionWith(seedBytes);
      await crowded.provision;
      const held = crowded.filesystem.holdCopies();
      const running = crowded.harness.seeds.provision(crowded.harness.spec);
      await held.started;
      let secondRefusal: unknown;
      const second = crowded.harness.seeds
        .provision(crowded.harness.spec)
        .catch((error: unknown) => {
          secondRefusal = error;
        });
      await vi.waitFor(() =>
        expect(secondRefusal !== undefined || crowded.filesystem.copies.length > 2).toBe(true),
      );
      expect(
        secondRefusal,
        "the second copy was refused while the first held the room",
      ).toMatchObject({
        name: "InsufficientDiskSpaceError",
      });
      held.release();
      await second;
      await expect(running).resolves.toMatchObject({ deviceId: expect.any(String) });

      // why: a copy that fails gives its reservation back, so the next copy is not refused for it.
      const interrupted = await provisionWith(seedBytes, 1);
      await expect(interrupted.provision).rejects.toThrow("cp: interrupted");
      await expect(
        interrupted.harness.seeds.provision(interrupted.harness.spec),
      ).resolves.toMatchObject({ deviceId: expect.any(String) });

      const short = await provisionWith(seedBytes - 1);
      const refusal = await short.provision.catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        availableBytes: seedBytes - 1,
        name: "InsufficientDiskSpaceError",
        platform: "android",
        requiredBytes: seedBytes,
      });
      expect((refusal as Error).message).toContain("to copy an Android seed:");
      expect(short.filesystem.copies).toEqual([]);
      expect(await short.filesystem.exists(copyHome)).toBe(false);
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
      const failed = expect(making).rejects.toThrow("did not finish within 300000 ms");
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
