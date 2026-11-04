import { DriverCrashError } from "../../core/index.js";
import type { ProcessRunner, TcpProbe } from "../../ports/index.js";
import { serialFor, type AdbTools } from "./adb-tools.js";
import type { AndroidDriverData, DeviceState } from "./data.js";

// why: Console ports, even ones only, each paired with the odd adb port above it. The range
// starts above the 5585 ceiling a default adb server scans, so the user's server and
// Android Studio cannot see, drive, or kill a Simlock emulator (ADR 0001, decision 4).
// It also repairs the old 5554-5682 range, which was broken at both ends: the bottom
// competed for the user's own emulators, and everything above 5585 read as free to the
// allocator below -- which derives occupancy from `adb devices` -- because no server could
// report a device up there. Simlock's server can, and not because it scans: with the
// scanner off, a transport exists for every port an emulator announced itself on or
// `#reattachRunningEmulators` swept, which is exactly this range.
export const PORT_MAX = 5682;
export const PORT_MIN = 5586;
// why: With `-port` set and no `-grpc`, the emulator opens no gRPC server and writes no
// `avd/running/pid_*.ini`, so tools that drive it over gRPC cannot find it. The emulator's own
// default, console port + 3000, keeps the endpoint per-console and so unique per lease
// (8586-8682 for Simlock's 5586-5682).
export const GRPC_PORT_OFFSET = 3000;

const allocationsByRunner = new WeakMap<ProcessRunner, PortAllocator>();

export class PortAllocator {
  readonly #reserved = new Set<number>();
  #lock = Promise.resolve();

  constructor(
    private readonly adb: string,
    private readonly processRunner: ProcessRunner,
  ) {}

  /**
   * why: The scoped environment and the probe are passed per call rather than held, because one
   * allocator is shared by every driver on a runner (see `portAllocatorFor`) while both
   * belong to one driver instance -- a stored environment would go stale the moment a
   * second driver appeared and would silently poll the wrong adb server.
   *
   * `adb devices` answers only for emulators announced to this instance's own server, so a
   * port it leaves free is then probed: an emulator another Simlock instance started is in
   * neither this process's reservations nor this server's list, but it holds its console
   * port and the adb port above it on the machine, and an emulator told to take either
   * exits at once. Each probe is one loopback connect, refused at once on a free port and
   * bounded by the probe's own timeout otherwise; the walk stops at the first free port, so
   * the wait is at most one probe pair per console port in the range.
   *
   * The probe sees only an emulator that is running now. A port handed out but not booted on
   * -- by another instance, or by this one before a restart emptied `#reserved` -- still
   * reads free here when its device sits between `provision` and `makeReady` or is shut
   * down, and two devices can then reach the same port at boot.
   */
  async allocate(env: NodeJS.ProcessEnv, tcpProbe: TcpProbe): Promise<number> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const result = await this.processRunner.run(this.adb, ["devices"], { env });
      if (result.code !== 0) {
        throw new DriverCrashError(`adb devices failed: ${result.stderr || result.stdout}`);
      }
      const unavailable = new Set([...this.#reserved, ...portsFromAdbDevices(result.stdout)]);
      for (let port = PORT_MIN; port <= PORT_MAX; port += 2) {
        if (!unavailable.has(port) && !(await consolePortsInUse(tcpProbe, port))) {
          this.#reserved.add(port);
          return port;
        }
      }
      throw new DriverCrashError("No Android emulator console ports are available");
    } finally {
      release();
    }
  }

  release(port: number): void {
    this.#reserved.delete(port);
  }
}

async function consolePortsInUse(tcpProbe: TcpProbe, consolePort: number): Promise<boolean> {
  const listening = await Promise.all([
    tcpProbe.isListening(consolePort),
    tcpProbe.isListening(consolePort + 1),
    tcpProbe.isListening(consolePort + GRPC_PORT_OFFSET),
  ]);
  return listening.includes(true);
}

export function portsFromAdbDevices(output: string): number[] {
  return [...output.matchAll(/^emulator-(\d+)\s+/gm)]
    .map((match) => Number(match[1]))
    .filter((port) => Number.isInteger(port));
}

export function portAllocatorFor(processRunner: ProcessRunner, adb: string): PortAllocator {
  const existing = allocationsByRunner.get(processRunner);
  if (existing !== undefined) {
    return existing;
  }
  const allocator = new PortAllocator(adb, processRunner);
  allocationsByRunner.set(processRunner, allocator);
  return allocator;
}

export interface ConsolePortsOptions {
  readonly adbTools: AdbTools;
  readonly allocator: PortAllocator;
  readonly tcpProbe: TcpProbe;
}

/**
 * why: the allocator a driver reaches is shared by every driver on a process runner, so two
 * drivers on one runner never hand out the same console port.
 */
export class ConsolePorts {
  readonly #options: ConsolePortsOptions;

  constructor(options: ConsolePortsOptions) {
    this.#options = options;
  }

  /**
   * why: The device's data on the console port this process reserved for it, taking one on its
   * first `prepare` boot here. The port its record names is never booted on as such: after a
   * restart nothing reserves it, so another device may have been handed it since (#52).
   */
  async withReservedPort(data: AndroidDriverData, state: DeviceState): Promise<AndroidDriverData> {
    state.port ??= await this.#options.allocator.allocate(
      this.#options.adbTools.env(),
      this.#options.tcpProbe,
    );
    return this.onReservedPort(data, state);
  }

  /** why: The reserved port is the truth; `data` is only what the registry last committed. */
  onReservedPort(data: AndroidDriverData, state: DeviceState): AndroidDriverData {
    return state.port === undefined
      ? data
      : { ...data, port: state.port, serial: serialFor(state.port) };
  }

  release(port: number): void {
    this.#options.allocator.release(port);
  }
}
