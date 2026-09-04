import { DriverCrashError, UnknownModelError } from "../../core/driver.js";
import type { Filesystem, ProcessRunner } from "../../ports/index.js";

/**
 * What `DeviceProfileSource#resolve` hands back for a model name. `builtin` is today's
 * `avdmanager -d <id>` path; `properties` is a hardware descriptor applied to `config.ini`
 * after `avdmanager create avd` (see `AndroidDriver#provision`) -- there is no `avdmanager`
 * device id for it because it never came from `avdmanager list device`. `name` is the
 * source's own canonical spelling of the model (case may differ from what the caller asked
 * for), which `AndroidDriver` needs so `DeviceSpec.model` and cache lookups stay stable.
 */
export type ResolvedDeviceProfile =
  | { readonly kind: "builtin"; readonly name: string; readonly avdmanagerId: string }
  | {
      readonly kind: "properties";
      readonly name: string;
      readonly hardwareProperties: Readonly<Record<string, string>>;
    };

/**
 * Diagnostics a `DeviceProfileSource` can raise. Sources never throw out of `resolve` /
 * `listModels` for a data problem (an absent, unreadable, or malformed file is not the
 * caller's fault) -- this is the only channel for surfacing that something was ignored.
 */
export interface DeviceProfileSourceDiagnostic {
  readonly kind: "device-profile-source-unreadable";
  readonly path: string;
  readonly reason: string;
}

/**
 * A read-only place `AndroidDriver` can load device profiles from. Simlock never writes to
 * any of these locations -- see safety rule 1 -- sources only load. Implementations must
 * never throw for a missing or malformed backing store; report that through the
 * `onDiagnostic` callback they were constructed with instead, and resolve to "nothing here."
 */
export interface DeviceProfileSource {
  /** Resolvable model names this source can currently answer for. */
  listModels(): Promise<readonly string[]>;
  /** `undefined` when this source has no profile for `model` -- never throws for a miss. */
  resolve(model: string): Promise<ResolvedDeviceProfile | undefined>;
}

/**
 * Ordered list of sources, first match wins. This is the whole extension point: a future
 * community/network source is a new `DeviceProfileSource` implementation plus one more entry
 * in the list a driver is constructed with -- nothing else in the driver changes.
 */
export class DeviceProfileRegistry {
  readonly #sources: readonly DeviceProfileSource[];

  constructor(sources: readonly DeviceProfileSource[]) {
    this.#sources = sources;
  }

  /** Dedupes by name, case-insensitively; the earliest source in the list wins a collision. */
  async listModels(): Promise<readonly string[]> {
    const seen = new Map<string, string>();
    for (const source of this.#sources) {
      for (const name of await source.listModels()) {
        const key = name.toLocaleLowerCase();
        if (!seen.has(key)) {
          seen.set(key, name);
        }
      }
    }
    return [...seen.values()];
  }

  async resolve(model: string): Promise<ResolvedDeviceProfile> {
    for (const source of this.#sources) {
      const resolved = await source.resolve(model);
      if (resolved !== undefined) {
        return resolved;
      }
    }
    throw new UnknownModelError("android", model);
  }
}

/** Today's behavior, refactored behind `DeviceProfileSource`: resolves against `avdmanager list device`. */
export class BuiltinDeviceProfileSource implements DeviceProfileSource {
  readonly #avdmanager: string;
  readonly #processRunner: ProcessRunner;

  constructor(avdmanager: string, processRunner: ProcessRunner) {
    this.#avdmanager = avdmanager;
    this.#processRunner = processRunner;
  }

  // fallow-ignore-next-line unused-class-member -- reached through the DeviceProfileSource port by DeviceProfileRegistry.listModels.
  async listModels(): Promise<readonly string[]> {
    return (await this.#profiles()).map((profile) => profile.name);
  }

  async resolve(model: string): Promise<ResolvedDeviceProfile | undefined> {
    const normalized = model.toLocaleLowerCase();
    const profile = (await this.#profiles()).find(
      (candidate) =>
        candidate.name.toLocaleLowerCase() === normalized ||
        candidate.id.toLocaleLowerCase() === normalized,
    );
    return profile === undefined
      ? undefined
      : { avdmanagerId: profile.id, kind: "builtin", name: profile.name };
  }

  async #profiles(): Promise<readonly AvdmanagerDeviceProfile[]> {
    const result = await this.#processRunner.run(this.#avdmanager, ["list", "device"]);
    if (result.code !== 0) {
      throw new DriverCrashError(
        `${this.#avdmanager} list device failed: ${result.stderr || result.stdout}`,
      );
    }
    return parseAvdmanagerDeviceProfiles(result.stdout);
  }
}

interface AvdmanagerDeviceProfile {
  readonly id: string;
  readonly name: string;
}

export function parseAvdmanagerDeviceProfiles(output: string): AvdmanagerDeviceProfile[] {
  const profiles: AvdmanagerDeviceProfile[] = [];
  let id: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"/.exec(line.trim());
    if (idMatch?.[1] !== undefined) {
      id = idMatch[1];
      continue;
    }
    const nameMatch = /^Name:\s*(.+)$/.exec(line.trim());
    if (id !== undefined && nameMatch?.[1] !== undefined) {
      profiles.push({ id, name: nameMatch[1] });
      id = undefined;
    }
  }
  return profiles;
}

/**
 * Read-only parse of Android Studio's `~/.android/devices.xml` -- that file belongs to
 * Android Studio; Simlock only ever reads it. Resolved profiles carry hardware properties
 * (screen resolution, density, RAM) applied to the simlock-created AVD's `config.ini`, since
 * there is no official profile store beyond `avdmanager`'s own built-ins to create the AVD
 * from directly.
 *
 * Parsed without a runtime dependency: a minimal, tolerant tag extractor rather than a real
 * XML parser (see `parseDevicesXml` below for exactly what it reads and what it deliberately
 * ignores).
 */
export class UserDeviceProfileSource implements DeviceProfileSource {
  readonly #filesystem: Filesystem;
  readonly #onDiagnostic: ((diagnostic: DeviceProfileSourceDiagnostic) => void) | undefined;
  readonly #path: string;

  constructor(
    path: string,
    filesystem: Filesystem,
    onDiagnostic?: (diagnostic: DeviceProfileSourceDiagnostic) => void,
  ) {
    this.#filesystem = filesystem;
    this.#onDiagnostic = onDiagnostic;
    this.#path = path;
  }

  async listModels(): Promise<readonly string[]> {
    return (await this.#profiles()).map((profile) => profile.name);
  }

  async resolve(model: string): Promise<ResolvedDeviceProfile | undefined> {
    const normalized = model.toLocaleLowerCase();
    const profile = (await this.#profiles()).find(
      (candidate) => candidate.name.toLocaleLowerCase() === normalized,
    );
    return profile === undefined
      ? undefined
      : { hardwareProperties: profile.hardwareProperties, kind: "properties", name: profile.name };
  }

  async #profiles(): Promise<readonly DevicesXmlProfile[]> {
    if (!(await this.#filesystem.exists(this.#path))) {
      // Android Studio never having run, or never having any custom profiles, is the common
      // case, not a diagnostic-worthy one.
      return [];
    }

    let contents: string;
    try {
      contents = await this.#filesystem.readFile(this.#path);
    } catch (error: unknown) {
      this.#reportUnreadable(errorMessage(error));
      return [];
    }

    try {
      return parseDevicesXml(contents);
    } catch (error: unknown) {
      this.#reportUnreadable(errorMessage(error));
      return [];
    }
  }

  #reportUnreadable(reason: string): void {
    this.#onDiagnostic?.({ kind: "device-profile-source-unreadable", path: this.#path, reason });
  }
}

interface DevicesXmlProfile {
  readonly name: string;
  readonly hardwareProperties: Readonly<Record<string, string>>;
}

/**
 * Maps a `<d:device>` element to the `config.ini` hardware properties `avdmanager -d` would
 * otherwise have produced. Mapped:
 *
 * - `<d:name>`               -> `hw.device.name`
 * - `<d:manufacturer>`       -> `hw.device.manufacturer` (when present)
 * - `<d:screen><d:dimensions><d:x-dimension>` / `<d:y-dimension>` -> `hw.lcd.width` / `hw.lcd.height`
 * - `<d:screen><d:pixel-density>`  -> `hw.lcd.density` (bucket name or `<n>dpi` -> numeric dpi)
 * - `<d:ram><d:ram-size unit="...">` -> `hw.ramSize` (converted to MiB, unit-suffix-free like avdmanager writes it)
 *
 * Deliberately skipped, because `config.ini`'s AVD-identity hash and the emulator's own
 * defaults cover them well enough that mirroring them exactly is not worth the parsing
 * surface: `<d:screen-size>` / `<d:diagonal-length>` / `<d:screen-ratio>` (physical form
 * factor, not a rendering input), `<d:xdpi>` / `<d:ydpi>` (physical DPI, distinct from the
 * rendering `pixel-density` bucket this already maps), `<d:buttons-type>`, `<d:keyboard>`,
 * `<d:nav>`, `<d:camera>`, `<d:sensors>`, `<d:cpu>`, `<d:gpu>`, `<d:abi>` (the system image
 * the caller picked already determines the ABI), `<d:storage>`, and the whole `<d:software>`
 * block (API-level / feature compatibility simlock resolves separately via the system image).
 * A device with multiple `<d:state>` hardware variants (e.g. a foldable's postures) is read
 * from whichever `<d:hardware>` block appears first in the file, matching `<d:screen>` /
 * `<d:ram>` textually rather than per-state.
 */
// fallow-ignore-next-line complexity -- per-field extraction and rejection checks are one parse pass over one <d:device> block.
export function parseDevicesXml(contents: string): readonly DevicesXmlProfile[] {
  const trimmed = contents.trim();
  if (trimmed === "") {
    return [];
  }
  if (!/<([\w.-]+:)?devices[\s/>]/i.test(trimmed)) {
    throw new Error("devices.xml has no recognizable <devices> root element");
  }

  const profiles: DevicesXmlProfile[] = [];
  for (const block of extractElements(trimmed, "device")) {
    const rawName = extractText(block, "name");
    if (rawName === undefined || rawName === "") {
      continue;
    }
    // A value containing CR, LF, or NUL is never a legitimate device name or property --
    // devices.xml is Android Studio's own file, but Simlock only ever reads it (safety rule 1),
    // and every value here eventually flows into a `config.ini` line-merge
    // (`AndroidDriver#applyHardwareProperties` -> `#mergeConfigIniLines`). A newline there would
    // inject an arbitrary extra `config.ini` key. Thrown rather than silently skipped or
    // sanitized: this routes through the same malformed-devices.xml diagnostic path the caller
    // (`UserDeviceProfileSource#profiles`) already has for an unparseable file, so a poisoned
    // value is surfaced rather than quietly dropped.
    if (containsForbiddenCharacter(rawName)) {
      throw new Error(`devices.xml device name contains an embedded line break or NUL byte`);
    }
    const name = unescapeXml(rawName);
    const hardwareProperties: Record<string, string> = { "hw.device.name": name };

    const manufacturer = extractText(block, "manufacturer");
    if (manufacturer !== undefined && manufacturer !== "") {
      if (containsForbiddenCharacter(manufacturer)) {
        throw new Error(
          `devices.xml manufacturer for device "${name}" contains an embedded line break or NUL byte`,
        );
      }
      hardwareProperties["hw.device.manufacturer"] = unescapeXml(manufacturer);
    }

    applyScreenProperties(block, hardwareProperties);
    applyRamProperty(block, hardwareProperties);

    // Defense in depth beyond the per-field checks above: every value about to leave this
    // parser (including ones a future field addition might forget to check individually) must
    // be a single line before it is handed to the driver -- the same invariant
    // `AndroidDriver#mergeConfigIniLines` enforces again on its own side, independently.
    if (Object.values(hardwareProperties).some(containsForbiddenCharacter)) {
      throw new Error(
        `devices.xml property for device "${name}" contains an embedded line break or NUL byte`,
      );
    }

    profiles.push({ hardwareProperties, name });
  }
  return profiles;
}

/** CR, LF, or NUL -- see the rejection check at the top of the `<d:device>` loop above. */
function containsForbiddenCharacter(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- NUL rejection is intentional, not an accidental control-character match.
  return /[\r\n\u0000]/.test(value);
}

function applyScreenProperties(
  deviceBlock: string,
  hardwareProperties: Record<string, string>,
): void {
  const screen = extractText(deviceBlock, "screen");
  if (screen === undefined) {
    return;
  }

  const dimensions = extractText(screen, "dimensions");
  if (dimensions !== undefined) {
    const width = extractText(dimensions, "x-dimension");
    const height = extractText(dimensions, "y-dimension");
    if (width !== undefined && /^\d+$/.test(width)) {
      hardwareProperties["hw.lcd.width"] = width;
    }
    if (height !== undefined && /^\d+$/.test(height)) {
      hardwareProperties["hw.lcd.height"] = height;
    }
  }

  const density = extractText(screen, "pixel-density");
  if (density !== undefined) {
    const dpi = densityToDpi(density);
    if (dpi !== undefined) {
      hardwareProperties["hw.lcd.density"] = String(dpi);
    }
  }
}

function applyRamProperty(deviceBlock: string, hardwareProperties: Record<string, string>): void {
  const ram = extractElement(deviceBlock, "ram-size");
  if (ram === undefined) {
    return;
  }
  const megabytes = ramSizeToMebibytes(ram.text, ram.attributes["unit"]);
  if (megabytes !== undefined) {
    hardwareProperties["hw.ramSize"] = String(megabytes);
  }
}

/** Android's standard density buckets, matching what `avdmanager`'s own built-ins resolve to. */
const DENSITY_BUCKETS_DPI: Readonly<Record<string, number>> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640,
};

function densityToDpi(raw: string): number | undefined {
  const key = raw.trim().toLowerCase();
  const bucket = DENSITY_BUCKETS_DPI[key];
  if (bucket !== undefined) {
    return bucket;
  }
  const numeric = /^(\d+)(dpi)?$/.exec(key);
  return numeric?.[1] === undefined ? undefined : Number(numeric[1]);
}

function ramSizeToMebibytes(text: string, unit: string | undefined): number | undefined {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) {
    return undefined;
  }
  switch ((unit ?? "MiB").trim().toUpperCase()) {
    case "KIB":
      return Math.round(value / 1024);
    case "GIB":
      return Math.round(value * 1024);
    case "TIB":
      return Math.round(value * 1024 * 1024);
    default:
      return Math.round(value);
  }
}

/** All top-level `<(ns:)tag>...</(ns:)tag>` blocks' inner content, in document order. */
function extractElements(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    "gi",
  );
  const blocks: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) {
      blocks.push(match[1]);
    }
  }
  return blocks;
}

/** The first `<(ns:)tag>...</(ns:)tag>` block's inner content, or undefined. */
function extractText(xml: string, tag: string): string | undefined {
  return extractElement(xml, tag)?.text;
}

/** The first `<(ns:)tag attr="...">...</(ns:)tag>` element's attributes and trimmed text. */
function extractElement(
  xml: string,
  tag: string,
): { readonly attributes: Readonly<Record<string, string>>; readonly text: string } | undefined {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`,
    "i",
  );
  const match = pattern.exec(xml);
  if (match === null) {
    return undefined;
  }
  const attributes: Record<string, string> = {};
  for (const attributeMatch of (match[1] ?? "").matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    const [, key, value] = attributeMatch;
    if (key !== undefined && value !== undefined) {
      attributes[key] = value;
    }
  }
  return { attributes, text: (match[2] ?? "").trim() };
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

function unescapeXml(value: string): string {
  return value.replace(/&(?:amp|apos|gt|lt|quot);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
