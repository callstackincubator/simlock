import { join } from "node:path";

import type {
  DriverDevice,
  DriverReality,
  LegacyDevice,
  ObservedDevice,
  ObservedMark,
} from "../../core/index.js";
import type { Filesystem } from "../../ports/index.js";
import { SEED_AVD_NAME, type AdbTools } from "./adb-tools.js";
import {
  ERASABLE_MARK_PATH,
  ERASABLE_MARK_READ_BYTES,
  MARK_READ_TIMEOUT_MS,
  parseErasableMark,
  type AvdConfig,
} from "./avd-config.js";
import { PORT_MAX, PORT_MIN } from "./console-ports.js";
import type { AndroidDriverData, DeviceState } from "./data.js";
import type { Ownership } from "./ownership.js";

interface DeviceEntry {
  readonly avdName: string;
  readonly deviceId: string;
  /** why: the AVD's own folder, which is what an emulator's `emu avd path` answers. */
  readonly folder: string;
}

export interface DeviceTableOptions {
  readonly adbTools: AdbTools;
  readonly avdConfig: AvdConfig;
  readonly avdmanager: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly deviceRoot: string;
  readonly filesystem: Filesystem;
  /** why: where an AVD Simlock made before it owned a root sits (ADR 0001, Migration). */
  readonly legacyAvdHome: string;
  readonly ownership: Ownership;
  /** why: announces one console port to Simlock's adb server; it swallows its own failures. */
  readonly register: (consolePort: number) => Promise<void>;
}

/** why: the part of AndroidDriver (ADR 0063) that owns the device states (keyed by AVD folder) and the per-device locks, and reports the devices the root holds. */
export class DeviceTable {
  readonly #adbTools: AdbTools;
  readonly #avdConfig: AvdConfig;
  readonly #devices = new Map<string, DeviceState>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #options: DeviceTableOptions;
  readonly #ownership: Ownership;

  constructor(options: DeviceTableOptions) {
    this.#adbTools = options.adbTools;
    this.#avdConfig = options.avdConfig;
    this.#options = options;
    this.#ownership = options.ownership;
  }

  /** why: the state of a device this process never provisioned is restored empty and flagged, so `destroy` knows to look for an attached emulator. */
  get(data: AndroidDriverData): DeviceState {
    const existing = this.#devices.get(this.#adbTools.avdFolder(data));
    if (existing !== undefined) {
      return existing;
    }
    const restored: DeviceState = {
      handle: undefined,
      imageIdentity: data.imageIdentity ?? "",
      port: undefined,
      restored: true,
    };
    this.#devices.set(this.#adbTools.avdFolder(data), restored);
    return restored;
  }

  set(data: AndroidDriverData, state: DeviceState): void {
    this.#devices.set(this.#adbTools.avdFolder(data), state);
  }

  delete(data: AndroidDriverData): void {
    this.#devices.delete(this.#adbTools.avdFolder(data));
  }

  async withLock<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(deviceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(deviceId, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(deviceId) === queued) {
        this.#locks.delete(deviceId);
      }
    }
  }

  /**
   * why: Looks for an AVD Simlock created before it owned a root, in the AVD home it would have
   * used then. Reached only for a registry device this root no longer holds, and it only
   * reads the filesystem. A legacy home that *is* the root means there is nothing pre-root
   * about the device -- it is simply gone -- and must never be answered through the
   * unscoped path below.
   */
  async findLegacy(driverDeviceId: string): Promise<LegacyDevice | undefined> {
    if (this.#options.legacyAvdHome === this.#options.deviceRoot) {
      return undefined;
    }
    const path = join(this.#options.legacyAvdHome, `${driverDeviceId}.avd`);
    if (!(await this.#options.filesystem.exists(path))) {
      return undefined;
    }

    return {
      device: {
        address: driverDeviceId,
        deviceId: driverDeviceId,
        // why: A stranded AVD has no console port and no serial: it is not running on Simlock's
        // server, and it is not this driver's business to look for it on anyone else's.
        driverData: {
          avdName: driverDeviceId,
          configHash: "",
          port: 0,
          serial: "",
        } satisfies AndroidDriverData,
      },
      path,
    };
  }

  /**
   * why: Permitted outside this driver's root because the registry names the AVD (safety rule 1). The
   * environment omits Simlock's adb server: stopping devices on a server it does not own is off limits.
   */
  async destroyLegacy(device: DriverDevice): Promise<void> {
    const { avdName } = this.#adbTools.dataFor(device);
    await this.#adbTools.runOrThrow(this.#options.avdmanager, ["delete", "avd", "-n", avdName], {
      env: { ...this.#options.baseEnv, ANDROID_AVD_HOME: this.#options.legacyAvdHome },
    });
  }

  /**
   * why: Announces every console port Simlock may have an emulator on to the server that was
   * just started or adopted -- deliberately doing, for Simlock's own range only, what adb's
   * scanner would do for everyone's.
   *
   * An emulator announces itself exactly once, at its own startup, to the server that
   * existed then. A `daemon stop` keeps that server only while `adb devices` lists an
   * emulator (`AndroidDriver#dispose`); one that is reaped or dies is replaced by a server
   * that, with `ADB_EMU=0`, has no scanner to rediscover anything -- so every emulator that
   * survived the restart (which is by design: a leased device keeps running across a stop)
   * would be invisible forever. Invisible is worse than gone: `listManaged` reports no process, so
   * `doctor` can never call it an orphan and several gigabytes of RSS leak permanently.
   *
   * `connect_emulator` is idempotent (adb keys transports by port), a port with nothing on
   * it is a cheap failed connect, and the range is bounded and Simlock's own -- so this is
   * safe to do unconditionally, and it never touches the user's emulators below 5586. It
   * also makes the design independent of whether a running emulator re-announces itself.
   */
  async reattachRunningEmulators(): Promise<void> {
    const ports: number[] = [];
    for (let consolePort = PORT_MIN; consolePort <= PORT_MAX; consolePort += 2) {
      ports.push(consolePort);
    }

    // why: `register` swallows its own failures, so one unreachable port cannot end the sweep.
    await Promise.all(ports.map((consolePort) => this.#options.register(consolePort)));
  }

  async listManaged(): Promise<DriverReality> {
    const entries = await this.#listDeviceEntries();
    const { settledSerials, unattributableTransitionalSerial } = await this.#adbTools.scanSerials();
    const { processes, runningByDeviceId, erasableMarkByDeviceId, unreadableSerial } =
      await this.#resolveRunningAvds(settledSerials, entries);
    const unattributable = unattributableTransitionalSerial || unreadableSerial;

    const devices: ObservedDevice[] = await Promise.all(
      entries.map((entry) =>
        this.#observedDevice(entry, runningByDeviceId, unattributable, erasableMarkByDeviceId),
      ),
    );

    return { devices, processes };
  }

  async #observedDevice(
    entry: DeviceEntry,
    runningByDeviceId: ReadonlySet<string>,
    unattributableTransitionalSerial: boolean,
    erasableMarkByDeviceId: ReadonlyMap<string, string | undefined>,
  ): Promise<ObservedDevice> {
    const base = observedAndroidDevice(
      entry.deviceId,
      entry.avdName,
      // why: a copy's destroy needs its folder; without it the device would be taken for one made before copies.
      entry.avdName === SEED_AVD_NAME ? join(this.#options.deviceRoot, entry.deviceId) : undefined,
      runningByDeviceId,
      unattributableTransitionalSerial,
    );
    const running = runningByDeviceId.has(entry.deviceId);
    const durable = await this.#avdConfig.readDurableMark(entry.folder);
    const mark = buildObservedMark(durable, running, erasableMarkByDeviceId.get(entry.deviceId));
    return mark === undefined ? base : { ...base, mark };
  }

  /**
   * why: Every AVD in the root, whatever it is called: a copy's folder `<root>/<id>/` holding
   * `simlock.avd`, or an AVD made before copies at `<root>/<name>.avd`. The name is a cosmetic
   * label with no authority: what makes these AVDs Simlock's is that they sit inside a root
   * Simlock created empty and marked, which nothing else can put an AVD into (safety rule 8).
   * `<root>/sources/` holds seeds, which are never devices.
   */
  async #listDeviceEntries(): Promise<DeviceEntry[]> {
    const { deviceRoot, filesystem } = this.#options;
    const entries: DeviceEntry[] = [];
    if (!(await filesystem.exists(deviceRoot))) return entries;
    for (const entry of await filesystem.readdir(deviceRoot)) {
      const old = /^(.+)\.avd$/.exec(entry);
      if (old?.[1] !== undefined) {
        entries.push({ avdName: old[1], deviceId: old[1], folder: `${deviceRoot}/${entry}` });
        continue;
      }
      const folder = `${deviceRoot}/${entry}/${SEED_AVD_NAME}.avd`;
      if (await this.#holdsAvd(folder)) {
        entries.push({ avdName: SEED_AVD_NAME, deviceId: entry, folder });
      }
    }
    return entries;
  }

  /** why: the root also holds files (the marker), and a path under a file is not an error here, only not an AVD. */
  async #holdsAvd(folder: string): Promise<boolean> {
    try {
      return await this.#options.filesystem.exists(folder);
    } catch {
      return false;
    }
  }

  /**
   * why: Names the device an attached emulator runs, if it is one of ours. Unreadable means the
   * emulator died between `adb devices` and this call: losing the whole reality view over one dead
   * serial would strand every other device, so it is unattributable this tick, nothing concluded.
   */
  async #attributeSerial(
    candidate: string,
    entries: readonly DeviceEntry[],
  ): Promise<
    | { readonly kind: "foreign" }
    | { readonly kind: "own"; readonly markLines: readonly string[]; readonly owner: DeviceEntry }
    | { readonly kind: "unreadable" }
  > {
    // why: `adb shell` reports the exit status of the last command it ran, so a missing
    // mark file would fail the whole invocation -- and a missing mark file is exactly
    // the foreign-erase case this feature exists to detect. `|| true` keeps an absent
    // mark an observation rather than a crash.
    const output = await this.#adbTools.shellOrUndefined(
      [
        "-s",
        candidate,
        "shell",
        `getprop ro.boot.qemu.avd_name; head -c ${String(ERASABLE_MARK_READ_BYTES)} ${ERASABLE_MARK_PATH} 2>/dev/null || true`,
      ],
      MARK_READ_TIMEOUT_MS,
    );
    if (output === undefined) return { kind: "unreadable" };
    const [nameLine = "", ...markLines] = output.stdout.split(/\r?\n/);
    // why: every copy's AVD is named `simlock`, so the name only narrows the candidates; the path the emulator answers picks the one device.
    const named = entries.filter((entry) => entry.avdName === nameLine.trim());
    if (named.length === 0) return { kind: "foreign" };
    let answered: string;
    try {
      answered = await this.#ownership.avdPathOf(candidate);
    } catch {
      // why: A serial can disappear after its shell answered; keep the observation
      // inconclusive just as when it disappears before that shell call.
      return { kind: "unreadable" };
    }
    for (const entry of named) {
      if (await this.#ownership.sameDirectory(answered, entry.folder)) {
        return { kind: "own", markLines, owner: entry };
      }
    }
    return { kind: "foreign" };
  }

  async #resolveRunningAvds(
    settledSerials: readonly string[],
    entries: readonly DeviceEntry[],
  ): Promise<{
    readonly erasableMarkByDeviceId: ReadonlyMap<string, string | undefined>;
    readonly processes: readonly DriverDevice[];
    readonly runningByDeviceId: ReadonlySet<string>;
    readonly unreadableSerial: boolean;
  }> {
    const processes: DriverDevice[] = [];
    const runningByDeviceId = new Set<string>();
    const erasableMarkByDeviceId = new Map<string, string | undefined>();
    let unreadableSerial = false;
    for (const candidate of settledSerials) {
      const attribution = await this.#attributeSerial(candidate, entries);
      if (attribution.kind === "unreadable") {
        unreadableSerial = true;
        continue;
      }
      if (attribution.kind === "foreign") continue;
      const { markLines, owner } = attribution;
      runningByDeviceId.add(owner.deviceId);
      erasableMarkByDeviceId.set(owner.deviceId, parseErasableMark(markLines.join("\n")));
      const port = Number(candidate.slice("emulator-".length));
      processes.push({
        address: candidate,
        deviceId: owner.deviceId,
        driverData: {
          ...(owner.avdName === SEED_AVD_NAME
            ? { avdHome: `${this.#options.deviceRoot}/${owner.deviceId}` }
            : {}),
          avdName: owner.avdName,
          configHash: "recovered",
          imageIdentity: "",
          port,
          serial: candidate,
        } satisfies AndroidDriverData,
      });
    }
    return { erasableMarkByDeviceId, processes, runningByDeviceId, unreadableSerial };
  }
}

function observedAndroidDevice(
  deviceId: string,
  avdName: string,
  avdHome: string | undefined,
  runningByDeviceId: ReadonlySet<string>,
  unattributableTransitionalSerial: boolean,
): ObservedDevice {
  return {
    // why: Reconnaissance only: an observed device is never granted, so it carries no usable address.
    address: "",
    deviceId,
    driverData: {
      ...(avdHome === undefined ? {} : { avdHome }),
      avdName,
      configHash: "recovered",
      imageIdentity: "",
      port: 0,
      serial: "",
    } satisfies AndroidDriverData,
    // why: Conservative: an emulator serial we can't attribute (transitional adb state) might
    // belong to any AVD that otherwise looks stopped, so treat all of them as transitioning
    // for this tick rather than risk a false-positive foreign-state-change finding.
    runState: runningByDeviceId.has(deviceId)
      ? "running"
      : unattributableTransitionalSerial
        ? "transitioning"
        : "stopped",
  };
}

/**
 * why: `undefined` (no `mark` at all) only when the durable key is absent *and* the device isn't
 * running: that is the upgrade path for an AVD provisioned before marks existed, where the
 * erasable half is also unreadable and can't corroborate either way. Reporting a half-empty
 * mark there would read as tampering (`durable-mark-missing`) on every tick forever. Once the
 * device is running with neither half present, a mark object is the correct, honest reading.
 */
function buildObservedMark(
  durable: string | undefined,
  running: boolean,
  erasable: string | undefined,
): ObservedMark | undefined {
  if (durable === undefined && !running) {
    return undefined;
  }
  return { durable, erasable: running ? erasable : undefined, erasableReadable: running };
}
