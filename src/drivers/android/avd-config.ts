import { DriverCrashError } from "../../core/index.js";
import { isMissingPathError, type Filesystem, type IdGenerator } from "../../ports/index.js";
import type { AdbTools } from "./adb-tools.js";
import type { AndroidDriverData, SystemImage } from "./data.js";
import { containsForbiddenCharacter, type DeviceProfile } from "./device-profile-source.js";
import { isPlayStoreImage } from "./image-fit.js";

export const MARK_READ_TIMEOUT_MS = 5_000;
export const ERASABLE_MARK_READ_BYTES = 4096;
export const ERASABLE_MARK_PATH = "/data/local/tmp/simlock-mark.json";
const DURABLE_MARK_KEY = "simlock.mark";

export interface AvdConfigOptions {
  readonly adb: string;
  readonly adbTools: AdbTools;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly seedLaunchInputs: readonly string[];
}

export class AvdConfig {
  readonly #options: AvdConfigOptions;

  constructor(options: AvdConfigOptions) {
    this.#options = options;
  }

  async applyLibraryProfile(
    folder: string,
    profile: Extract<DeviceProfile, { readonly kind: "library" }>,
    image: SystemImage,
  ): Promise<void> {
    await this.#mergeConfigIniLines(
      folder,
      {
        ...profile.hardware,
        "PlayStore.enabled": profile.playStore && isPlayStoreImage(image) ? "yes" : "no",
      },
      (line) => !isSeedHardwareLine(line),
    );
    const bootPropPath = `${folder}/boot.prop`;
    const properties = Object.entries(profile.bootProperties);
    if (properties.length > 0) {
      await this.#options.filesystem.writeFileAtomic(
        bootPropPath,
        `${properties.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
      );
    } else if (await this.#options.filesystem.exists(bootPropPath)) {
      await this.#options.filesystem.rm(bootPropPath);
    }
  }

  async applyHardwareProperties(
    folder: string,
    properties: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#mergeConfigIniLines(folder, properties);
  }

  /**
   * why: What a seed's boot snapshot depends on. A mismatch against the hash stored with the seed
   * makes it stale, so it is made again rather than copied into devices whose snapshot the
   * emulator would refuse.
   */
  async currentConfigHash(
    folder: string,
    imageIdentity: string,
    knownEmulatorVersion?: string,
  ): Promise<string> {
    const [emulatorVersion, config] = await Promise.all([
      knownEmulatorVersion ?? this.#options.adbTools.emulatorVersion(),
      this.#avdConfig(folder),
    ]);
    return stableHash([imageIdentity, emulatorVersion, config, ...this.#options.seedLaunchInputs]);
  }

  async #avdConfig(folder: string): Promise<string> {
    try {
      const contents = await this.#options.filesystem.readFile(`${folder}/config.ini`);
      return (
        contents
          .split(/\r?\n/)
          .filter((line) => /^(image\.sysdir\.1|hw\.|disk\.dataPartition\.)/.test(line))
          // why: `avdmanager` writes `hw.device.hash2` into every AVD in the home, and the emulator
          // ignores it, so counting it would make every seed stale.
          .filter((line) => !line.startsWith("hw.device.hash2="))
          .sort()
          .join("\n")
      );
    } catch {
      return "";
    }
  }

  /**
   * why: Writes the same provenance token into both regions of the mark: the durable
   * `simlock.mark` key in `config.ini` (host-side, survives an erase) and the erasable
   * `/data/local/tmp/simlock-mark.json` file on the device (destroyed by an erase). Must be
   * called after every readiness transition -- see the call sites in `makeReady`.
   */
  async writeMark(data: AndroidDriverData): Promise<void> {
    const token = this.#options.idGenerator.generate();
    await Promise.all([
      this.#writeDurableMark(this.#options.adbTools.avdFolder(data), token),
      this.#writeErasableMark(data.serial, token),
    ]);
  }

  async #writeDurableMark(folder: string, token: string): Promise<void> {
    await this.#mergeConfigIniLines(folder, { [DURABLE_MARK_KEY]: token });
  }

  async #mergeConfigIniLines(
    folder: string,
    entries: Readonly<Record<string, string>>,
    keepLine: (line: string) => boolean = () => true,
  ): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      if (containsForbiddenCharacter(key) || containsForbiddenCharacter(value)) {
        throw new DriverCrashError(
          `Refusing to merge config.ini entry with a line break or NUL (key ${JSON.stringify(key)})`,
        );
      }
    }
    const path = `${folder}/config.ini`;
    let contents: string;
    try {
      contents = await this.#options.filesystem.readFile(path);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      contents = "";
    }
    const lines = (contents === "" ? [] : contents.replace(/\r?\n$/, "").split(/\r?\n/)).filter(
      keepLine,
    );
    for (const [key, value] of Object.entries(entries)) {
      const line = `${key}=${value}`;
      const existingIndex = lines.findIndex((entry) => entry.startsWith(`${key}=`));
      if (existingIndex >= 0) {
        lines[existingIndex] = line;
      } else {
        lines.push(line);
      }
    }
    await this.#options.filesystem.writeFileAtomic(path, `${lines.join("\n")}\n`);
  }

  async #writeErasableMark(serial: string, token: string): Promise<void> {
    const payload = JSON.stringify({ token });
    await this.#options.adbTools.runOrThrow(this.#options.adb, [
      "-s",
      serial,
      "shell",
      `echo '${payload}' > ${ERASABLE_MARK_PATH}`,
    ]);
  }

  async readDurableMark(folder: string): Promise<string | undefined> {
    try {
      const contents = await this.#options.filesystem.readFile(`${folder}/config.ini`);
      const line = contents
        .split(/\r?\n/)
        .find((entry) => entry.startsWith(`${DURABLE_MARK_KEY}=`));
      const value = line?.slice(`${DURABLE_MARK_KEY}=`.length).trim();
      return value === undefined || value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }
}

export function iniValues(contents: string, key: RegExp): string[] {
  return contents.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    if (separator === -1 || !key.test(line.slice(0, separator).trim())) return [];
    const value = line.slice(separator + 1).trim();
    return value === "" ? [] : [value];
  });
}

export function parseErasableMark(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { readonly token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function isSeedHardwareLine(line: string): boolean {
  return (
    (line.startsWith("hw.") && !line.startsWith("hw.cpu.arch=")) ||
    line.startsWith("vm.heapSize=") ||
    line.startsWith("skin.")
  );
}

export function assertLibraryProfileWritable(
  profile: Extract<DeviceProfile, { readonly kind: "library" }>,
): void {
  for (const [key, value] of [
    ...Object.entries(profile.hardware),
    ...Object.entries(profile.bootProperties),
  ]) {
    if (containsForbiddenCharacter(key) || containsForbiddenCharacter(value)) {
      throw new DriverCrashError(
        `Refusing library profile ${JSON.stringify(profile.name)}: ${JSON.stringify(key)} holds a line break or NUL`,
      );
    }
  }
}

function stableHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const character of parts.join("\u0000")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
