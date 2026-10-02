import { describe, expect, it } from "vitest";

import { OWNED_ROOT_MARKER_FILE } from "../../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  MemoryFilesystem,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type TcpProbe,
} from "../../ports/index.js";
import { AndroidDriver } from "./index.js";

// Two Simlock instances on one machine, set up the way CLI.md and CONFIGURATION.md say to:
// a distinct `SIMLOCK_HOME` each, and a distinct `drivers.android.adbServerPort` each.
// They share the SDK, the system images, and the machine's TCP ports.

const sdk = "/android-sdk";
const home = "/home/simlock";
const binaries = {
  adb: `${sdk}/platform-tools/adb`,
  avdmanager: `${sdk}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${sdk}/emulator/emulator`,
  sdkmanager: `${sdk}/cmdline-tools/latest/bin/sdkmanager`,
} as const;
const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;
const spec = { model: "Pixel 8", osVersion: "34", platform: "android" } as const;

interface Instance {
  readonly adbServerPid: number;
  readonly adbServerPort: number;
  /** The id of the first AVD this instance creates; its name is `simlock_<avdId>`. */
  readonly avdId: string;
  readonly instanceId: string;
  readonly simlockHome: string;
}

const first: Instance = {
  adbServerPid: 4242,
  adbServerPort: 5038,
  avdId: "first",
  instanceId: "instance-first",
  simlockHome: `${home}/.simlock-first`,
};
const second: Instance = {
  adbServerPid: 4343,
  adbServerPort: 5039,
  avdId: "second",
  instanceId: "instance-second",
  simlockHome: `${home}/.simlock-second`,
};

describe("AndroidDriver with two Simlock instances on one machine (#257)", () => {
  it("provisions a device on a console port no other instance's emulator is listening on", async () => {
    const machine = await Machine.with([first, second]);

    // The second instance is already running when the first boots a device, so nothing has
    // announced that emulator to the second instance's server.
    const secondDriver = await machine.start(second);
    const firstDriver = await machine.start(first);
    await firstDriver.resolveSpec(spec);
    await firstDriver.makeReady(await firstDriver.provision(spec));

    await secondDriver.resolveSpec(spec);
    const provisioned = await secondDriver.provision(spec);

    expect(
      machine.avdListeningAt(provisioned.address),
      `the emulator already listening on ${provisioned.address}, the address the second instance gave its new device`,
    ).toBeUndefined();
  });
});

/**
 * One machine: the SDK, every emulator running on it, and the adb servers Simlock instances
 * run. As much of `avdmanager`, `emulator` and `adb` as provisioning, a first boot and a
 * baseline capture use.
 *
 * What it models is adb's, not Simlock's. Each server holds a transport only for an emulator
 * that was announced to it -- the emulator announces itself to the server its
 * `ANDROID_ADB_SERVER_PORT` names, and `host:emulator:<adbPort>` announces one to whichever
 * server receives it -- because every Simlock server runs with its scanner off (`ADB_EMU=0`).
 * `adb devices` and `adb -s` see only that server's transports. An emulator told to take a
 * console port another one holds exits at once (`emulator -help`, 36.1.9: "if any of these
 * ports is already used, the emulator will fail to start"). A console port and the adb port
 * above it are TCP ports on the machine, so a probe sees them whichever instance owns them.
 */
class Machine {
  /** Console port -> the AVD whose emulator is listening on it. */
  readonly #listening = new Map<number, string>();
  /** Console port -> the adb servers holding a transport to the emulator on it. */
  readonly #attached = new Map<number, Set<number>>();
  readonly #exits = new Map<number, () => void>();
  #nextPid = 1;

  private constructor(
    private readonly filesystem: MemoryFilesystem,
    private readonly instances: readonly Instance[],
  ) {}

  static async with(instances: readonly Instance[]): Promise<Machine> {
    const filesystem = new MemoryFilesystem();
    for (const binary of Object.values(binaries)) {
      await filesystem.mkdirp(binary.slice(0, binary.lastIndexOf("/")));
      await filesystem.writeFileAtomic(binary, "binary");
    }
    await filesystem.mkdirp(`${sdk}/system-images/android-34/google_apis/arm64-v8a`);
    for (const instance of instances) {
      // Each instance's own root, created and marked by an earlier run of that instance.
      const root = deviceRootOf(instance);
      await filesystem.mkdirp(root);
      await filesystem.writeFileAtomic(
        `${root}/${OWNED_ROOT_MARKER_FILE}`,
        JSON.stringify({
          instanceId: instance.instanceId,
          owner: "simlock",
          platform: "android",
          schemaVersion: 1,
        }),
      );
      // Each instance's own adb server, already running, which the driver adopts.
      await filesystem.writeFileAtomic(
        `${instance.simlockHome}/adb-server.json`,
        JSON.stringify({ pid: instance.adbServerPid, port: instance.adbServerPort, startedAt: 1 }),
      );
    }
    return new Machine(filesystem, instances);
  }

  /** Starts one instance's Android driver: a daemon process of its own, so a runner of its own. */
  async start(instance: Instance): Promise<AndroidDriver> {
    let nextId = 0;
    return AndroidDriver.create({
      clock: new FakeClock(),
      driverConfig: { adbServerPort: instance.adbServerPort },
      env: { ANDROID_HOME: sdk },
      filesystem: this.filesystem,
      homeDirectory: home,
      hostAbi: "arm64-v8a",
      idGenerator: {
        generate: () => (nextId++ === 0 ? instance.avdId : `${instance.avdId}-${nextId}`),
      },
      instanceId: instance.instanceId,
      processRunner: this.#runner(),
      processSupervisor: new FakeProcessSupervisor([instance.adbServerPid]),
      simlockHome: instance.simlockHome,
      tcpProbe: this.#tcpProbe(),
    });
  }

  /** The AVD whose emulator is listening on `serial`'s console port, or `undefined`. */
  avdListeningAt(serial: string | undefined): string | undefined {
    return this.#listening.get(consolePortOf(serial));
  }

  #tcpProbe(): TcpProbe {
    return {
      isListening: async (port) =>
        this.instances.some((instance) => instance.adbServerPort === port) ||
        this.#listening.has(port) ||
        this.#listening.has(port - 1),
      send: async (serverPort, payload) => {
        const adbPort = Number(/host:emulator:(\d+)$/.exec(payload)?.[1]);
        // adb answers by connecting out to the emulator's adb port; nothing there, no transport.
        if (this.#listening.has(adbPort - 1)) this.#attach(adbPort - 1, serverPort);
        return "";
      },
    };
  }

  #runner(): ProcessRunner {
    return {
      run: (command, args, options) => this.#run(command, args, options),
      spawn: (command, args, options) => this.#spawn(command, args, options),
      spawnStreaming: (command, args) => {
        throw new Error(`Unexpected streaming invocation: ${command} ${args.join(" ")}`);
      },
    };
  }

  async #run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions | undefined,
  ): Promise<ProcessResult> {
    const result =
      command === binaries.avdmanager
        ? await this.#avdmanager(args, options)
        : command === binaries.adb
          ? this.#adb(args, serverPortOf(options))
          : command === binaries.emulator && args[0] === "-version"
            ? ok("Android emulator version 36.1.9")
            : undefined;
    if (result === undefined) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }
    return result;
  }

  async #avdmanager(
    args: readonly string[],
    options: ProcessRunOptions | undefined,
  ): Promise<ProcessResult | undefined> {
    if (args[0] === "list") return ok(pixelDevices);
    if (args[0] !== "create") return undefined;
    const avdHome = options?.env?.["ANDROID_AVD_HOME"];
    if (avdHome === undefined) throw new Error("avdmanager ran without ANDROID_AVD_HOME");
    const avdName = args[args.indexOf("-n") + 1] ?? "";
    await this.filesystem.mkdirp(`${avdHome}/${avdName}.avd`);
    await this.filesystem.writeFileAtomic(
      `${avdHome}/${avdName}.avd/config.ini`,
      "hw.ramSize=2048\n",
    );
    return ok();
  }

  #adb(args: readonly string[], serverPort: number): ProcessResult | undefined {
    if (args[0] === "devices") {
      const lines = [...this.#listening.keys()]
        .filter((port) => this.#attached.get(port)?.has(serverPort) === true)
        .map((port) => `emulator-${port}\tdevice\n`);
      return ok(`List of devices attached\n${lines.join("")}`);
    }
    if (args[0] !== "-s") return undefined;
    const port = consolePortOf(args[1]);
    if (this.#attached.get(port)?.has(serverPort) !== true) {
      return { code: 1, stderr: `adb: device '${args[1]}' not found`, stdout: "" };
    }
    const rest = args.slice(2).join(" ");
    if (rest === "emu kill") {
      this.#exit(port);
      return ok("OK: killing emulator, bye bye\n");
    }
    if (rest.startsWith("shell echo ")) return ok();
    const answer = ADB_ANSWERS.get(rest);
    return answer === undefined ? undefined : ok(answer);
  }

  #spawn(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions | undefined,
  ): ProcessHandle {
    if (command !== binaries.emulator || args[0] !== "-avd") {
      throw new Error(`Unexpected spawn: ${command} ${args.join(" ")}`);
    }
    const avdName = args[1] ?? "";
    const port = Number(args[args.indexOf("-port") + 1]);
    let exit!: (result: ProcessResult) => void;
    const exited = new Promise<ProcessResult>((resolve) => {
      exit = resolve;
    });
    const bound = !this.#listening.has(port);
    if (bound) {
      this.#listening.set(port, avdName);
      this.#exits.set(port, () => exit(ok()));
      // An emulator announces itself to the server its environment names.
      this.#attach(port, serverPortOf(options));
    } else {
      exit({ code: 1, stderr: `console port ${port} is already used`, stdout: "" });
    }
    return {
      // Killing an emulator that never bound must not stop the one that did.
      kill: () => {
        if (bound && this.#listening.get(port) === avdName) this.#exit(port);
      },
      pid: this.#nextPid++,
      stderr: emptyLines(),
      stdout: emptyLines(),
      unref: () => undefined,
      wait: () => exited,
    };
  }

  #attach(consolePort: number, serverPort: number): void {
    const servers = this.#attached.get(consolePort) ?? new Set<number>();
    servers.add(serverPort);
    this.#attached.set(consolePort, servers);
  }

  #exit(port: number): void {
    this.#listening.delete(port);
    this.#attached.delete(port);
    this.#exits.get(port)?.();
    this.#exits.delete(port);
  }
}

/** What a booted emulator answers to the `adb -s <serial>` commands a first boot and a baseline capture send. */
const ADB_ANSWERS = new Map([
  ["shell getprop sys.boot_completed", "1\n"],
  ["shell getprop init.svc.bootanim", "stopped\n"],
  ["emu avd snapshot save simlock_clean_baseline", "OK\n"],
  ["emu avd snapshot list", "simlock_clean_baseline\n"],
]);

function deviceRootOf(instance: Instance): string {
  return `${instance.simlockHome}/devices/android`;
}

function serverPortOf(options: ProcessRunOptions | undefined): number {
  const port = Number(options?.env?.["ANDROID_ADB_SERVER_PORT"]);
  if (!Number.isInteger(port)) throw new Error("adb ran without ANDROID_ADB_SERVER_PORT");
  return port;
}

function consolePortOf(serial: string | undefined): number {
  return Number(/^emulator-(\d+)$/.exec(serial ?? "")?.[1]);
}

function ok(stdout = ""): ProcessResult {
  return { code: 0, stderr: "", stdout };
}

async function* emptyLines(): AsyncIterable<string> {
  // An emulator Simlock spawns is never read from.
}
