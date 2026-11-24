import {
  MemoryFilesystem,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { basename } from "node:path";
import { processResult, pixelDevices, avdDirectory, binaries, ok } from "./test-sdk-fixtures.js";
import { emulatorHelpListing, writeSeedFiles } from "./test-seed-harness.js";

/**
 * why: The emulators on one machine, which outlive any one daemon: as much of `avdmanager`,
 * `emulator` and `adb` as provisioning, booting, saving a snapshot and stopping use. Each
 * `runner()` is one daemon process's view of it -- the driver keeps its port reservations per
 * runner, as a real daemon keeps them per process.
 *
 * Two behaviours are the real tools', not Simlock's. An emulator told to take a console port
 * another one holds exits at once: `emulator -help` (36.1.9) says that "if any of these ports
 * is already used, the emulator will fail to start". And a serial is answered by whichever
 * emulator is listening on its port.
 */
export class EmulatorHost {
  /** why: the AVD folder each console port's emulator runs, as its `emu avd path` answers it. */
  readonly #listening = new Map<number, string>();
  readonly #exits = new Map<number, () => void>();
  readonly #pids = new Map<number, number>();
  /** why: the `logcat` listeners a driver has open; a default network that comes up is announced to each. */
  readonly #logcats = new Set<(line: string) => void>();
  #nextPid = 1;
  /** why: the network id `dumpsys connectivity` names as the default one; `undefined` before the guest has one. A real emulator has one almost at once, so a test that is about the wait sets it to `undefined`. */
  defaultNetwork: number | undefined = 100;
  /** why: what `emu avd snapshot list` prints; a test of a save that did not take empties it. */
  snapshotListing = "simlock_boot\n";

  constructor(private readonly filesystem: MemoryFilesystem) {}

  pathAnswering(serial: string | undefined): string | undefined {
    return this.#listening.get(consolePortOf(serial));
  }

  /** why: the guest's ConnectivityService picking a default network: the line `logcat` prints for it, to every open listener. */
  announceDefaultNetwork(): void {
    for (const announce of this.#logcats) {
      announce(
        "ConnectivityService: Sending CONNECTED broadcast for type 1 [100 WIFI] isDefaultNetwork=true",
      );
    }
  }

  /** why: an emulator that dies on its own, as one does when the guest crashes or the host runs out of memory. */
  crash(serial: string): void {
    this.#exit(consolePortOf(serial));
  }

  /** why: the pid the runner gave the emulator listening on a serial, which is what a process table names as the root of its tree. */
  pidAnswering(serial: string | undefined): number | undefined {
    return this.#pids.get(consolePortOf(serial));
  }

  /** why: the id of the device whose AVD answers: a copy's folder name, or an old-layout AVD's name. */
  avdAnswering(serial: string | undefined): string | undefined {
    const folder = this.#listening.get(consolePortOf(serial));
    if (folder === undefined) return undefined;
    const home = folder.slice(0, folder.lastIndexOf("/"));
    return home === avdDirectory ? basename(folder, ".avd") : basename(home);
  }

  runner(): ProcessRunner {
    return {
      run: (command, args, options) => this.#run(command, args, options?.env),
      spawn: (command, args, options) => this.#spawn(command, args, options?.env),
      spawnStreaming: (command, args) => {
        throw new Error(`Unexpected streaming invocation: ${command} ${args.join(" ")}`);
      },
    };
  }

  async #run(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<ProcessResult> {
    const result =
      command === binaries.avdmanager
        ? await this.#avdmanager(args, env?.["ANDROID_AVD_HOME"] ?? avdDirectory)
        : command === binaries.adb
          ? this.#adb(args)
          : command === binaries.emulator
            ? emulatorQuery(args)
            : undefined;
    if (result === undefined) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }
    return result;
  }

  async #avdmanager(args: readonly string[], home: string): Promise<ProcessResult | undefined> {
    if (args[0] === "list") return ok(pixelDevices);
    const avdName = args[args.indexOf("-n") + 1] ?? "";
    if (args[0] === "delete") {
      await this.filesystem.rm(`${home}/${avdName}.avd`);
      return ok();
    }
    if (args[0] !== "create") return undefined;
    await writeSeedFiles(this.filesystem, home, "hw.ramSize=2048\n", avdName);
    return ok();
  }

  // fallow-ignore-next-line complexity -- one fake adb: each branch answers one command of the table.
  #adb(args: readonly string[]): ProcessResult | undefined {
    if (args[0] === "devices") {
      const lines = [...this.#listening.keys()].map((port) => `emulator-${port}\tdevice\n`);
      return ok(`List of devices attached\n${lines.join("")}`);
    }
    if (args[0] !== "-s") return undefined;
    const port = consolePortOf(args[1]);
    if (!this.#listening.has(port)) {
      return { code: 1, stderr: `adb: device '${args[1]}' not found`, stdout: "" };
    }
    const rest = args.slice(2).join(" ");
    if (rest === "emu kill" || rest === "shell reboot -p") {
      this.#exit(port);
      return ok("OK: killing emulator, bye bye\n");
    }
    if (rest === "emu avd snapshot list") return ok(this.snapshotListing);
    if (rest === "shell dumpsys connectivity") {
      return ok(`Active default network: ${this.defaultNetwork ?? "none"}\n`);
    }
    if (rest.startsWith("shell echo ")) return ok();
    if (rest.startsWith("shell getprop ro.boot.qemu.avd_name; head -c ")) {
      return ok(`${basename(this.#listening.get(port) ?? "", ".avd")}\n`);
    }
    if (rest === "emu avd path") {
      return ok(`${this.#listening.get(port) ?? ""}\r\nOK\r\n`);
    }
    const answer = ADB_ANSWERS.get(rest);
    return answer === undefined ? undefined : ok(answer);
  }

  #spawn(
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv | undefined,
  ): ProcessHandle {
    if (command === binaries.adb && args.includes("logcat")) return this.#logcat();
    if (command !== binaries.emulator || args[0] !== "-avd") {
      throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
    }
    const avdName = `${env?.["ANDROID_AVD_HOME"] ?? avdDirectory}/${args[1] ?? ""}.avd`;
    const port = Number(args[args.indexOf("-port") + 1]);
    let exit!: (result: ProcessResult) => void;
    const exited = new Promise<ProcessResult>((resolve) => {
      exit = resolve;
    });
    const bound = !this.#listening.has(port);
    const pid = this.#nextPid++;
    if (bound) {
      this.#listening.set(port, avdName);
      this.#pids.set(port, pid);
      this.#exits.set(port, () => exit({ code: 0, stderr: "", stdout: "" }));
    } else {
      exit({ code: 1, stderr: `console port ${port} is already used`, stdout: "" });
    }
    return {
      // why: Killing an emulator that never bound must not stop the one that did.
      kill: () => {
        if (bound && this.#listening.get(port) === avdName) this.#exit(port);
      },
      pid,
      stderr: emptyLines(),
      stdout: emptyLines(),
      unref: () => undefined,
      wait: () => exited,
    };
  }

  /** why: a one-shot `logcat -m 1`: it ends with the first line it prints, or when it is killed. */
  #logcat(): ProcessHandle {
    let end!: (result: ProcessResult) => void;
    const ended = new Promise<ProcessResult>((resolve) => {
      end = resolve;
    });
    const announce = (line: string) => {
      this.#logcats.delete(announce);
      end({ code: 0, stderr: "", stdout: `${line}\n` });
    };
    this.#logcats.add(announce);
    return {
      kill: () => {
        this.#logcats.delete(announce);
        end({ code: null, stderr: "", stdout: "" });
      },
      pid: this.#nextPid++,
      stderr: emptyLines(),
      stdout: emptyLines(),
      unref: () => undefined,
      wait: () => ended,
    };
  }

  #exit(port: number): void {
    this.#listening.delete(port);
    this.#exits.get(port)?.();
    this.#exits.delete(port);
  }
}

export class RecordingRunner implements ProcessRunner {
  readonly calls: { args: readonly string[]; command: string; options: ProcessRunOptions }[] = [];

  constructor(private readonly inner: ProcessRunner) {}

  run(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.run(command, args, options);
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}) {
    this.calls.push({ args, command, options });
    return this.inner.spawn(command, args, options);
  }

  spawnStreaming(...args: Parameters<ProcessRunner["spawnStreaming"]>) {
    return this.inner.spawnStreaming(...args);
  }
}

const ADB_ANSWERS = new Map([
  ["shell getprop sys.boot_completed", "1\n"],
  ["shell getprop init.svc.bootanim", "stopped\n"],
  ["shell pm path android", "package:/system/framework/framework-res.apk\n"],
  ["shell sync", ""],
  ["emu avd snapshot save simlock_boot", "OK\n"],
  ["emu avd snapshot list", "simlock_boot\n"],
]);

export function consolePortOf(serial: string | undefined): number {
  return Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
}

export async function* emptyLines(): AsyncIterable<string> {}

/** why: what a running copy answers to `emu avd path`: the AVD inside its own folder. */
export function copyPathExpectation(
  serial: string,
  folder = "simlock_one",
): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${folder}/simlock.avd\r\nOK\r\n`,
  );
}

/** why: the two read-only `emulator` calls the fake answers; any other is unexpected. */
function emulatorQuery(args: readonly string[]): ProcessResult | undefined {
  if (args[0] === "-version") return ok("Android emulator version 36.1.9");
  if (args[0] === "-help") return ok(emulatorHelpListing);
  return undefined;
}
