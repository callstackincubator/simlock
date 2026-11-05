import { join } from "node:path";

import {
  BootTimeoutError,
  DriverCrashError,
  type DeviceSpec,
  type DriverDevice,
} from "../../core/index.js";
import type {
  Clock,
  Filesystem,
  ProcessHandle,
  ProcessRunner,
  TcpProbe,
  TimerHandle,
} from "../../ports/index.js";
import { AdbRegistrar } from "./adb-registrar.js";
import { deviceIdOf, type AdbTools } from "./adb-tools.js";
import { GRPC_PORT_OFFSET } from "./console-ports.js";
import type { AndroidDriverData } from "./data.js";
import { androidDriverConfig, type AndroidEmulatorLaunchOptions } from "./definition.js";
import { OWNERSHIP_PROBE_TIMEOUT_MS, type Ownership } from "./ownership.js";
import { emulatorHelpLists } from "./sdk-paths.js";

// why: Measured at 60-71s for a cold boot to `sys.boot_completed` on an M-series Mac against
// Pixel 8 / API 35 (ADR-era hardware verification), against the 31s this first quoted.
// Under-quoting matters more than over-quoting: `Doctor` derives its stalled-transition
// threshold from this number, so a low estimate flags healthy boots on a slower machine.
export const COLD_BOOT_ESTIMATE_MS = 70_000;
const PORT_POLL_INTERVAL_MS = 2_000;
// why: After this long without an answer from a serial, the emulator's own registration is
// assumed lost and Simlock re-sends it. Long enough that a normally-booting emulator has
// already attached, short enough that a lost announcement costs seconds, not the whole
// readiness timeout.
const REGISTRATION_RETRY_AFTER_MS = 5_000;
// why: A defense-in-depth bound on the wait that follows a SIGKILL: NodeProcessHandle#wait
// already settles shortly after `exit`, but this keeps a pathologically slow reap
// from ever turning a "we already killed it" cleanup into an unbounded await.
export const SIGKILL_REAP_TIMEOUT_MS = 5_000;
const EMULATOR_LOG_TAIL_BYTES = 8_192;
const EMULATOR_LOG_TAIL_LINES = 10;
const SNAPSHOT_BOOT_ESTIMATE_MS = 4_000;

export const DEFAULT_EMULATOR_LAUNCH = androidDriverConfig.defaults.emulator;

const EMULATOR_HELP_TIMEOUT_MS = 30_000;

export interface SnapshotColdBootDiagnostic {
  readonly deviceId: string;
  readonly kind: "snapshot-cold-boot";
  readonly readyAfterMs: number;
}

export interface EmulatorOptions {
  readonly adb: string;
  readonly adbServerPort: number;
  readonly adbTools: AdbTools;
  readonly clock: Clock;
  readonly deviceRoot: string;
  readonly emulator: string;
  readonly emulatorLaunch: AndroidEmulatorLaunchOptions | undefined;
  readonly filesystem: Filesystem;
  readonly onDiagnostic: ((diagnostic: SnapshotColdBootDiagnostic) => void) | undefined;
  readonly ownership: Ownership;
  readonly processRunner: ProcessRunner;
  readonly readinessTimeoutMs: number;
  readonly tcpProbe: TcpProbe;
}

export class Emulator {
  readonly #options: EmulatorOptions;
  readonly #flags: readonly string[];
  readonly #registrar: AdbRegistrar;
  #acceptsCrashReportMode: Promise<readonly string[]> | undefined;

  constructor(options: EmulatorOptions) {
    this.#options = options;
    this.#flags = emulatorLaunchFlags(options.emulatorLaunch);
    this.#registrar = new AdbRegistrar({
      serverPort: options.adbServerPort,
      tcp: options.tcpProbe,
    });
  }

  /**
   * why: Announces an emulator to Simlock's adb server, which with the scanner off is what
   * attaches it (see `AdbRegistrar`). Always best-effort: the emulator announces itself
   * too, so a failure here is usually a duplicate of something that already worked, and
   * failing a boot over it would trade a working device for a redundant message.
   */
  async register(consolePort: number): Promise<void> {
    try {
      await this.#registrar.register(consolePort + 1);
    } catch {}
  }

  /**
   * why: a dump an earlier crash left in a crash database makes the emulator open a modal consent dialog at launch, which blocks its main thread before any port opens; `never` skips the dialog and deletes the dumps in the database it reads, so `#env` points that at Simlock's own root and never at the user's shared one. An older emulator (36.1.9) exits at `unknown option` on the flag (#1297), so it is passed only when `-help` lists it; the answer is kept for the process, and a `-help` that fails leaves the flag out.
   */
  #crashReportFlags(): Promise<readonly string[]> {
    this.#acceptsCrashReportMode ??= this.#options.processRunner
      .run(this.#options.emulator, ["-help"], { timeoutMs: EMULATOR_HELP_TIMEOUT_MS })
      .then((result) =>
        emulatorHelpLists(`${result.stdout}\n${result.stderr}`, "-crash-report-mode")
          ? ["-crash-report-mode", "never"]
          : [],
      )
      .catch(() => []);
    return this.#acceptsCrashReportMode;
  }

  /**
   * why: `-crash-report-mode never` deletes every dump in the crash database the emulator reads, and
   * by default that is `/tmp/android-<user>/emu-crash-<version>.db`, shared with Android Studio and
   * the user's own emulators. A database inside Simlock's own root keeps those dumps untouched.
   */
  #env(data: AndroidDriverData): NodeJS.ProcessEnv {
    return {
      ...this.#options.adbTools.env(),
      ...(data.avdHome === undefined ? {} : { ANDROID_AVD_HOME: data.avdHome }),
      ANDROID_EMU_CRASH_REPORTING_DATABASE: join(this.#options.deviceRoot, "emu-crash.db"),
    };
  }

  /**
   * why: An orphan found after a restart has no handle and no usable serial, so the emulator
   * running its AVD is found by asking each attached one which AVD folder it runs. Deletion is
   * refused when that emulator does not exit in time, never done under a live process.
   */
  async stopUnowned(data: AndroidDriverData): Promise<void> {
    const { settledSerials } = await this.#options.adbTools.scanSerials();
    const serials = await this.#options.ownership.serialsRunningAvd(data, settledSerials);
    for (const serial of serials) {
      await this.#options.processRunner.run(this.#options.adb, ["-s", serial, "emu", "kill"], {
        env: this.#options.adbTools.env(),
        timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
      });
    }
    await this.#waitForEmulatorsToExit(data, serials);
  }

  async #waitForEmulatorsToExit(data: AndroidDriverData, serials: string[]): Promise<void> {
    const startedAt = this.#options.clock.now();
    let remaining = serials;
    while (remaining.length > 0) {
      const attached = (await this.#options.adbTools.scanSerials()).settledSerials;
      remaining = remaining.filter((serial) => attached.includes(serial));
      if (remaining.length === 0) return;
      if (this.#options.clock.now() - startedAt >= this.#options.readinessTimeoutMs) {
        throw new DriverCrashError(
          `Refusing to delete ${deviceIdOf(data)}: its emulator on ${remaining.join(", ")} did not exit`,
        );
      }
      await this.#options.adbTools.delay(PORT_POLL_INTERVAL_MS);
    }
  }

  #logPath(data: AndroidDriverData): string {
    return `${this.#options.adbTools.avdFolder(data)}/emulator.log`;
  }

  /** why: bounded, since an emulator that ran a while may have written a lot before it exited. */
  async #logTail(logPath: string): Promise<string> {
    try {
      const { size } = await this.#options.filesystem.stat(logPath);
      const text = await this.#options.filesystem.readFileFrom(
        logPath,
        Math.max(0, size - EMULATOR_LOG_TAIL_BYTES),
      );
      return text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .slice(-EMULATOR_LOG_TAIL_LINES)
        .join("\n");
    } catch {
      return "(the emulator's log could not be read)";
    }
  }

  async waitForReadiness(
    data: AndroidDriverData,
    startedAt: number,
    abandoned: () => boolean = () => false,
  ): Promise<void> {
    const { adbTools, clock, readinessTimeoutMs } = this.#options;
    while (!abandoned()) {
      if (clock.now() - startedAt >= readinessTimeoutMs) {
        throw new BootTimeoutError(data.avdName);
      }

      const completed = await this.#options.processRunner.run(
        this.#options.adb,
        ["-s", data.serial, "shell", "getprop", "sys.boot_completed"],
        { env: adbTools.env() },
      );
      if (completed.code !== 0) {
        // why: A serial that will not answer is a serial the server has no transport for, which
        // is the same evidence "absent from `adb devices`" would give and costs no extra
        // round trip. Past the grace period, assume the emulator's own announcement was
        // lost -- with the scanner off nothing else will ever re-send it -- and re-announce.
        if (clock.now() - startedAt >= REGISTRATION_RETRY_AFTER_MS) {
          await this.register(data.port);
        }
        await adbTools.delay(
          Math.min(PORT_POLL_INTERVAL_MS, readinessTimeoutMs - (clock.now() - startedAt)),
        );
        continue;
      }
      if (completed.stdout.trim() === "1") {
        if (await this.#bootSettled(data)) return;
      }

      await adbTools.delay(
        Math.min(PORT_POLL_INTERVAL_MS, readinessTimeoutMs - (clock.now() - startedAt)),
      );
    }
  }

  /**
   * why: After a snapshot load both boot properties pass before `pm` answers, so a device granted
   * then fails its first install or package query.
   */
  async #bootSettled(data: AndroidDriverData): Promise<boolean> {
    const bootAnimation = await this.#options.adbTools.runOrThrow(this.#options.adb, [
      "-s",
      data.serial,
      "shell",
      "getprop",
      "init.svc.bootanim",
    ]);
    const stopped = bootAnimation.stdout.trim();
    if (stopped !== "" && stopped !== "stopped") return false;
    await this.#options.ownership.confirmAvdAnswers(data);
    const answer = await this.#options.processRunner.run(
      this.#options.adb,
      ["-s", data.serial, "shell", "pm", "path", "android"],
      { env: this.#options.adbTools.env() },
    );
    return answer.code === 0 && answer.stdout.includes("package:");
  }

  async start(
    data: AndroidDriverData,
    launchArgs: readonly string[],
    fromSnapshot: boolean,
  ): Promise<ProcessHandle> {
    const startedAt = this.#options.clock.now();
    const logPath = this.#logPath(data);
    await this.#options.filesystem.writeFileAtomic(logPath, "", { mode: 0o600 });
    // why: the output goes to a file so a launch that dies at once leaves its own error line to quote (#1199); `unref()` because an emulator outlives the daemon by design
    // (`AndroidDriver` adopts it after a restart) and is reaped through adb and
    // by pid, never by awaiting its exit. Left referenced, its handle and stdio pipes would hold
    // the event loop open, and a `daemon stop` that had logged "Daemon stopped" would leave
    // the process alive for as long as any emulator ran.
    const handle = this.#options.processRunner.spawn(
      this.#options.emulator,
      [
        "-avd",
        data.avdName,
        "-port",
        String(data.port),
        "-no-snapshot-save",
        "-grpc",
        String(data.port + GRPC_PORT_OFFSET),
        "-grpc-use-token",
        ...(await this.#crashReportFlags()),
        ...this.#flags,
        ...launchArgs,
      ],
      // why: on Windows a kill otherwise ends `emulator.exe` alone, and its qemu child keeps
      // running with the guest's RAM; no adb command asks for this (the 5037 server rule).
      { env: this.#env(data), killTree: true, stdio: { file: logPath } },
    );
    handle.unref();
    // why: No announcement here, deliberately. adb answers `host:emulator:<port>` by connecting
    // *out* to that port, and the emulator has not opened it yet a millisecond after the
    // spawn -- so a call here could only ever fail, and with the scanner off nothing drains
    // adb's retry queue afterwards. The announcement that can land is the one in
    // `waitForReadiness`, once the serial has stayed silent past the grace period.

    // why: an emulator that exits before it boots never will; waiting out the boot timeout for it hides the reason it left in its log.
    let waiting = true;
    const exited = handle.wait().then(async (result): Promise<never> => {
      if (!waiting) return new Promise<never>(() => undefined);
      throw new DriverCrashError(
        `The emulator for ${data.avdName} exited (code ${result.code ?? "none"}) before it booted:\n${await this.#logTail(logPath)}`,
      );
    });
    exited.catch(() => undefined);
    const readiness = this.waitForReadiness(data, startedAt, () => !waiting);
    readiness.catch(() => undefined);
    try {
      await Promise.race([readiness, exited]);
    } catch (error: unknown) {
      waiting = false;
      handle.kill("SIGKILL");
      await this.waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
      throw error;
    }
    waiting = false;

    const readyAfterMs = this.#options.clock.now() - startedAt;
    if (fromSnapshot && readyAfterMs > SNAPSHOT_BOOT_ESTIMATE_MS * 3) {
      this.#options.onDiagnostic?.({
        deviceId: deviceIdOf(data),
        kind: "snapshot-cold-boot",
        readyAfterMs,
      });
    }
    return handle;
  }

  // why: async so a device id that does not match its AVD rejects the promise `AndroidDriver.estimate` returns, as it did before this part existed; the lease coordinator's fallback reads a rejection and never a throw.
  async bootEstimate(
    device: DriverDevice,
    purpose: "prepare" | "recover" | undefined,
    spec: DeviceSpec,
  ): Promise<number> {
    if (spec.physical || purpose === "recover") return COLD_BOOT_ESTIMATE_MS;
    return this.#options.adbTools.dataFor(device).avdHome === undefined
      ? COLD_BOOT_ESTIMATE_MS
      : SNAPSHOT_BOOT_ESTIMATE_MS;
  }

  async shutdown(data: AndroidDriverData, handle: ProcessHandle | undefined): Promise<void> {
    if (data.port > 0 && (await this.#options.ownership.serialIsOwn(data))) {
      await this.#options.processRunner.run(this.#options.adb, ["-s", data.serial, "emu", "kill"], {
        env: this.#options.adbTools.env(),
        timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS,
      });
    }
    if (handle === undefined) {
      return;
    }

    const exited = await this.waitForExit(handle, this.#options.readinessTimeoutMs);
    if (!exited) {
      handle.kill("SIGKILL");
      await this.waitForExit(handle, SIGKILL_REAP_TIMEOUT_MS);
    }
  }

  async waitForExit(handle: ProcessHandle, timeoutMs: number): Promise<boolean> {
    let timer: TimerHandle | undefined;
    try {
      return await Promise.race([
        handle.wait().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = this.#options.clock.setTimer(timeoutMs, () => resolve(false));
        }),
      ]);
    } finally {
      // why: An armed timer holds the event loop open, so a stopped daemon would outlive it (#237).
      if (timer !== undefined) {
        this.#options.clock.cancel(timer);
      }
    }
  }
}

function emulatorLaunchFlags(
  launch: AndroidEmulatorLaunchOptions = DEFAULT_EMULATOR_LAUNCH,
): string[] {
  return [
    ...(launch.headless ? ["-no-window"] : []),
    ...(launch.gpu === DEFAULT_EMULATOR_LAUNCH.gpu ? [] : ["-gpu", launch.gpu]),
    ...(launch.audio ? [] : ["-no-audio"]),
    ...(launch.bootAnimation ? [] : ["-no-boot-anim"]),
  ];
}
