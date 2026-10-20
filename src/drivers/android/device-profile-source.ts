import { DriverCrashError, UnknownModelError, type DeviceClass } from "../../core/index.js";
import type { Filesystem, ProcessRunner } from "../../ports/index.js";

export type DeviceProfile =
  | {
      readonly kind: "builtin";
      readonly name: string;
      readonly names: readonly string[];
      readonly avdmanagerId: string;
      readonly custom: boolean;
      /** From the entry's `Tag :` line (ADR 0015 §3); `undefined` for a tag the table does not know. */
      readonly deviceClass: DeviceClass | undefined;
      readonly tag?: string | undefined;
      readonly apiRange?: ApiRange | undefined;
      readonly playStore?: boolean | undefined;
      readonly tablet?: boolean | undefined;
    }
  | {
      readonly kind: "library";
      readonly name: string;
      readonly id: string;
      readonly names: readonly string[];
      readonly deviceClass: DeviceClass;
      readonly imageKind: string | undefined;
      readonly apiRange: { readonly min: number; readonly max?: number };
      readonly playStore: boolean;
      readonly tablet: boolean;
      readonly hardware: Readonly<Record<string, string>>;
      readonly bootProperties: Readonly<Record<string, string>>;
      readonly copiedFrom: string;
    }
  | {
      readonly kind: "properties";
      readonly name: string;
      readonly names: readonly string[];
      readonly hardwareProperties: Readonly<Record<string, string>>;
      readonly imageKind?: string | undefined;
      readonly apiRange?: ApiRange | undefined;
      readonly playStore?: boolean | undefined;
      readonly tablet?: boolean | undefined;
    };

type ApiRange = { readonly min: number; readonly max?: number };

/**
 * Diagnostics a `DeviceProfileSource` can raise. Sources never throw out of `profiles` for a
 * data problem (an absent, unreadable, or malformed file is not the caller's fault) -- this is
 * the only channel for surfacing that something was ignored.
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
 * `onDiagnostic` callback they were constructed with instead, and return no profiles.
 */
export interface DeviceProfileSource {
  /** Every profile this source currently has, in its own order. Matching is not its job. */
  profiles(): Promise<readonly DeviceProfile[]>;
}

/** The registry's answer for the catalog: listed models, and the other names each answers to. */
export interface DeviceProfileCatalog {
  readonly models: readonly string[];
  /** Only models with another name appear, keyed by their spelling in `models`. */
  readonly modelAliases: Readonly<Record<string, readonly string[]>>;
  /**
   * The listed models whose name resolves to a `properties` profile or a `custom` `builtin`
   * one: a custom profile from this machine rather than one the SDK ships. In `models` order.
   */
  readonly customModels: readonly string[];
  /** The class of each listed model that has one, keyed by its spelling in `models`. */
  readonly modelClasses: Readonly<Record<string, DeviceClass>>;
}

/**
 * Ordered list of sources, first match wins. This is the whole extension point: a future
 * community/network source is a new `DeviceProfileSource` implementation plus one more entry
 * in the list a driver is constructed with -- nothing else in the driver changes.
 *
 * It owns the only matcher (`matchProfile`): `resolve` and the catalog's other names both go
 * through it, so a listed name always resolves to the model it is listed under.
 */
export class DeviceProfileRegistry {
  readonly #sources: readonly DeviceProfileSource[];

  constructor(sources: readonly DeviceProfileSource[]) {
    this.#sources = sources;
  }

  /**
   * `models` dedupes by name, case-insensitively, the earliest profile winning a collision. A
   * profile whose name an earlier profile only answers to as another name stays listed, as it
   * always has. A profile's other names are listed only where they resolve to that profile.
   */
  async catalog(): Promise<DeviceProfileCatalog> {
    return (await this.catalogWithProfiles()).catalog;
  }

  // fallow-ignore-next-line complexity -- the catalog is one pass over the listed profiles.
  async catalogWithProfiles(): Promise<{
    readonly catalog: DeviceProfileCatalog;
    readonly modelProfiles: ReadonlyMap<string, DeviceProfile>;
  }> {
    const profiles = await this.#profiles();
    const listed = new Map<string, DeviceProfile>();
    for (const profile of profiles) {
      const key = profile.name.toLocaleLowerCase();
      if (!listed.has(key)) {
        listed.set(key, profile);
      }
    }
    const modelAliases: Record<string, readonly string[]> = {};
    for (const profile of listed.values()) {
      const others = profile.names
        .slice(1)
        .filter((name) => matchProfile(profiles, name) === profile);
      if (others.length > 0) {
        modelAliases[profile.name] = others;
      }
    }
    const models = [...listed.values()].map((profile) => profile.name);
    // Custom by the profile the name resolves to, not the one it was listed from: a
    // devices.xml name that a real SDK profile already answers to stays listed but is built-in.
    const customModels = models.filter((model) => {
      const profile = matchProfile(profiles, model);
      return profile !== undefined && isCustom(profile);
    });
    // why: a lease of a name creates the profile that name resolves to, so its class in
    // the catalog must come from that profile, not the one it happened to be listed from.
    const modelClasses: Record<string, DeviceClass> = {};
    for (const model of models) {
      const profile = matchProfile(profiles, model);
      const deviceClass =
        profile === undefined
          ? undefined
          : profile.kind === "properties"
            ? classOfTag(profile.imageKind)
            : profile.deviceClass;
      if (deviceClass !== undefined) modelClasses[model] = deviceClass;
    }
    const modelProfiles = new Map<string, DeviceProfile>();
    for (const model of models) {
      const profile = matchProfile(profiles, model);
      if (profile !== undefined) modelProfiles.set(model, profile);
    }
    return {
      catalog: { customModels, modelAliases, modelClasses, models },
      modelProfiles,
    };
  }

  /**
   * why: sources are read in order and stop at the first match, so a model that matches an
   * SDK profile never opens devices.xml. A custom built-in match also reads every later source,
   * for the devices.xml details it fits by. The first match in the first source that has one is
   * the first match in the whole list, so this agrees with `catalog`.
   */
  async resolve(model: string): Promise<DeviceProfile> {
    for (const [index, source] of this.#sources.entries()) {
      const profile = matchProfile(await source.profiles(), model);
      if (profile !== undefined) {
        if (profile.kind !== "builtin" || !profile.custom) {
          return profile;
        }
        const later: DeviceProfile[] = [];
        for (const next of this.#sources.slice(index + 1)) {
          later.push(...(await next.profiles()));
        }
        return withDevicesXmlDetails(profile, later);
      }
    }
    throw new UnknownModelError("android", model);
  }

  async #profiles(): Promise<readonly DeviceProfile[]> {
    const profiles: DeviceProfile[] = [];
    for (const source of this.#sources) {
      profiles.push(...(await source.profiles()));
    }
    return profiles.map((profile) => withDevicesXmlDetails(profile, profiles));
  }
}

function withDevicesXmlDetails(
  profile: DeviceProfile,
  candidates: readonly DeviceProfile[],
): DeviceProfile {
  if (profile.kind !== "builtin" || !profile.custom) return profile;
  const details = matchProfile(
    candidates.filter((candidate) => candidate.kind === "properties"),
    profile.name,
  );
  if (details?.kind !== "properties") return profile;
  return {
    ...profile,
    apiRange: details.apiRange,
    playStore: details.playStore,
    tablet: details.tablet,
  };
}

/** Made on this machine rather than shipped with the SDK. */
function isCustom(profile: DeviceProfile): boolean {
  return profile.kind === "properties" || (profile.kind === "builtin" && profile.custom);
}

/** The first profile any of whose names is `model`, ignoring case. */
function matchProfile(
  profiles: readonly DeviceProfile[],
  model: string,
): DeviceProfile | undefined {
  const normalized = model.toLocaleLowerCase();
  return profiles.find((profile) =>
    profile.names.some((name) => name.toLocaleLowerCase() === normalized),
  );
}

interface HiddenUserProfile {
  readonly userName: string;
  readonly libraryName: string;
}

export async function hiddenUserProfiles(
  library: DeviceProfileSource,
  user: DeviceProfileSource,
): Promise<readonly HiddenUserProfile[]> {
  const libraryProfiles = await library.profiles();
  const hidden: HiddenUserProfile[] = [];
  for (const profile of await user.profiles()) {
    const shadow = profile.names
      .map((name) => matchProfile(libraryProfiles, name))
      .find((match) => match !== undefined);
    if (shadow !== undefined) {
      hidden.push({ libraryName: shadow.name, userName: profile.name });
    }
  }
  return hidden;
}

/** Today's behavior, refactored behind `DeviceProfileSource`: resolves against `avdmanager list device`. */
export class BuiltinDeviceProfileSource implements DeviceProfileSource {
  readonly #avdmanager: string;
  readonly #processRunner: ProcessRunner;
  readonly #env: (() => NodeJS.ProcessEnv) | undefined;

  /**
   * `env` is a thunk, not a value: it is the driver's own scoped environment (ADR 0001,
   * decision 4), and the driver builds it from state it only settles once the AVD root is
   * proven. Reading it per call means this source can never be handed a snapshot that was
   * taken before containment was established.
   *
   * Omitting it leaves the child's environment inherited rather than replaced -- an empty
   * override is not "no override", it is a child spawned with no `PATH` at all.
   */
  constructor(avdmanager: string, processRunner: ProcessRunner, env?: () => NodeJS.ProcessEnv) {
    this.#avdmanager = avdmanager;
    this.#processRunner = processRunner;
    this.#env = env;
  }

  /**
   * Answers to its display name and, when it differs ignoring case, its avdmanager id. SDK
   * profiles come before custom ones, so a real SDK profile wins a name clash with a
   * devices.xml one whatever order `avdmanager` prints them in.
   */
  async profiles(): Promise<readonly DeviceProfile[]> {
    const profiles = (await this.#avdmanagerProfiles()).map(
      (profile): DeviceProfile => ({
        avdmanagerId: profile.id,
        custom: profile.oem === "User",
        deviceClass: classOfTag(profile.tag),
        kind: "builtin",
        name: profile.name,
        names:
          profile.id.toLocaleLowerCase() === profile.name.toLocaleLowerCase()
            ? [profile.name]
            : [profile.name, profile.id],
        tag: profile.tag,
      }),
    );
    return [
      ...profiles.filter((profile) => !isCustom(profile)),
      ...profiles.filter((profile) => isCustom(profile)),
    ];
  }

  async #avdmanagerProfiles(): Promise<readonly AvdmanagerDeviceProfile[]> {
    const result = await this.#processRunner.run(
      this.#avdmanager,
      ["list", "device"],
      this.#env === undefined ? {} : { env: this.#env() },
    );
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
  /** The entry's `OEM :` line, or undefined without one. `User` marks a devices.xml profile. */
  readonly oem: string | undefined;
  /** The entry's `Tag :` line, or undefined without one. */
  readonly tag: string | undefined;
}

/**
 * ADR 0015 §3: which avdmanager tag is which device class. No tag is a phone; a tag this table
 * does not know has no class.
 */
function classOfTag(tag: string | undefined): DeviceClass | undefined {
  if (tag === undefined) return "phone";
  if (tag === "android-tv") return "tv";
  if (tag === "android-wear") return "watch";
  if (tag.startsWith("android-automotive")) return "auto";
  if (tag === "android-desktop") return "desktop";
  return undefined;
}

/**
 * One profile per `id:` entry that has a `Name:` line. `OEM :` comes after `Name:`, so an
 * entry is complete only at the next `id:` line or the end of the output.
 */
export function parseAvdmanagerDeviceProfiles(output: string): AvdmanagerDeviceProfile[] {
  const profiles: AvdmanagerDeviceProfile[] = [];
  let entry:
    | { id: string; name: string | undefined; oem: string | undefined; tag: string | undefined }
    | undefined;
  const flush = (): void => {
    if (entry?.name !== undefined) {
      profiles.push({ id: entry.id, name: entry.name, oem: entry.oem, tag: entry.tag });
    }
  };
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const idMatch = /^id:\s*\d+\s+or\s+"([^"]+)"/.exec(trimmed);
    if (idMatch?.[1] !== undefined) {
      flush();
      entry = { id: idMatch[1], name: undefined, oem: undefined, tag: undefined };
      continue;
    }
    if (entry === undefined) {
      continue;
    }
    const nameMatch = /^Name:\s*(.+)$/.exec(trimmed);
    if (nameMatch?.[1] !== undefined) {
      entry.name = nameMatch[1];
      continue;
    }
    const oemMatch = /^OEM\s*:\s*(.+)$/.exec(trimmed);
    if (oemMatch?.[1] !== undefined) {
      entry.oem = oemMatch[1];
      continue;
    }
    const tagMatch = /^Tag\s*:\s*(.+)$/.exec(trimmed);
    if (tagMatch?.[1] !== undefined) {
      entry.tag = tagMatch[1];
    }
  }
  flush();
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

  /** Each profile answers to its `<d:name>` only. */
  async profiles(): Promise<readonly DeviceProfile[]> {
    return (await this.#devicesXmlProfiles()).map((profile) => ({
      apiRange: profile.apiRange,
      hardwareProperties: profile.hardwareProperties,
      imageKind: profile.imageKind,
      kind: "properties",
      playStore: profile.playStore,
      tablet: profile.tablet,
      name: profile.name,
      names: [profile.name],
    }));
  }

  async #devicesXmlProfiles(): Promise<readonly DevicesXmlProfile[]> {
    let contents: string;
    try {
      // `exists` answers false only when the file is absent; any other failure to check (an
      // `.android` the daemon may not search, or one that is a file) is unreadable, below.
      if (!(await this.#filesystem.exists(this.#path))) {
        // Android Studio never having run, or never having any custom profiles, is the common
        // case, not a diagnostic-worthy one.
        return [];
      }
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
  readonly imageKind: string | undefined;
  readonly apiRange: ApiRange | undefined;
  readonly playStore: boolean;
  readonly tablet: boolean;
}

/**
 * why: there is no official store to create an AVD from a devices.xml profile directly, so this
 * maps a `<d:device>` element to the `config.ini` hardware properties `avdmanager -d` would
 * otherwise have produced. Mapped:
 *
 * - `<d:name>`               -> `hw.device.name`
 * - `<d:manufacturer>`       -> `hw.device.manufacturer` (when present)
 * - `<d:screen><d:dimensions><d:x-dimension>` / `<d:y-dimension>` -> `hw.lcd.width` / `hw.lcd.height`
 * - `<d:screen><d:pixel-density>`  -> `hw.lcd.density` (bucket name or `<n>dpi` -> numeric dpi)
 * - `<d:ram unit="...">n</d:ram>` -> `hw.ramSize` (unit B/KiB/MiB/GiB/TiB, converted to MiB,
 *   unit-suffix-free like avdmanager writes it; an unknown unit leaves `hw.ramSize` unset)
 *
 * Deliberately skipped, because `config.ini`'s AVD-identity hash and the emulator's own
 * defaults cover them well enough that mirroring them exactly is not worth the parsing
 * surface: `<d:screen-size>` / `<d:screen-ratio>` (physical form factor, not a rendering
 * input), `<d:xdpi>` / `<d:ydpi>` (physical DPI, distinct from the
 * rendering `pixel-density` bucket this already maps), `<d:buttons-type>`, `<d:keyboard>`,
 * `<d:nav>`, `<d:camera>`, `<d:sensors>`, `<d:cpu>`, `<d:gpu>`, `<d:abi>` (the system image
 * the caller picked already determines the ABI), `<d:storage>`, and the rest of `<d:software>`.
 *
 * Read for the system image a profile fits, not for the AVD: `<d:tag-id>`,
 * `<d:software><d:api-level>`, `<d:playstore-enabled>`, `<d:diagonal-length>` and the
 * `<d:x-folded-dimension>` / `<d:y-folded-dimension>` pair.
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
    // (`UserDeviceProfileSource#devicesXmlProfiles`) already has for an unparseable file, so a poisoned
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
    const fit = readFitFields(block, name);

    // Defense in depth beyond the per-field checks above: every value about to leave this
    // parser (including ones a future field addition might forget to check individually) must
    // be a single line before it is handed to the driver -- the same invariant
    // `AndroidDriver#mergeConfigIniLines` enforces again on its own side, independently.
    if (Object.values(hardwareProperties).some(containsForbiddenCharacter)) {
      throw new Error(
        `devices.xml property for device "${name}" contains an embedded line break or NUL byte`,
      );
    }

    profiles.push({ ...fit, hardwareProperties, name });
  }
  return profiles;
}

/** CR, LF, or NUL -- see the rejection check at the top of the `<d:device>` loop above. */
export function containsForbiddenCharacter(value: string): boolean {
  // oxlint-disable-next-line no-control-regex -- NUL rejection is intentional, not an accidental control-character match.
  return /[\r\n\u0000]/.test(value);
}

const TAG_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const API_LEVEL_PATTERN = /^(\d{1,3})?(-)?(\d{1,3})?$/;
const MAX_API_LEVEL = 999;
const TABLET_MIN_DIAGONAL_INCHES = 7;
const MAX_DIAGONAL_INCHES = 100;

function fitText(xml: string, tag: string, name: string, container = false): string | undefined {
  const element = extractElement(xml, tag);
  if (element === undefined) return undefined;
  if (!container && containsForbiddenCharacter(element.raw)) {
    throw new Error(
      `devices.xml ${tag} for device "${name}" contains an embedded line break or NUL byte`,
    );
  }
  return element.text;
}

function apiBound(value: string): number | undefined {
  const number = Number(value);
  return number >= 1 && number <= MAX_API_LEVEL ? number : undefined;
}

// fallow-ignore-next-line complexity -- the range forms are one pass over one pattern match.
function parseApiRange(text: string | undefined): ApiRange | undefined {
  const match = text === undefined ? null : API_LEVEL_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, low = "", dash, high = ""] = match;
  const min = apiBound(low);
  const max = apiBound(high);
  const bounded = (low === "" || min !== undefined) && (high === "" || max !== undefined);
  if (!bounded || (low === "" && high === "") || (dash === undefined && high !== "")) {
    return undefined;
  }
  if (dash === undefined) return { max: min as number, min: min as number };
  const range = { ...(max === undefined ? {} : { max }), min: min ?? 1 };
  return max !== undefined && range.min > max ? undefined : range;
}

// fallow-ignore-next-line complexity -- one bounded read per fit field of one <d:device> block.
function readFitFields(
  block: string,
  name: string,
): Pick<DevicesXmlProfile, "apiRange" | "imageKind" | "playStore" | "tablet"> {
  const tagId = fitText(block, "tag-id", name);
  const imageKind = tagId !== undefined && TAG_ID_PATTERN.test(tagId) ? tagId : undefined;
  const software = fitText(block, "software", name, true);
  const apiRange = parseApiRange(
    software === undefined ? undefined : fitText(software, "api-level", name),
  );
  const playStore =
    fitText(block, "playstore-enabled", name) !== "false" || imageKind === "android-wear";
  const screen = fitText(block, "screen", name, true);
  const inScreen = (tag: string): string | undefined =>
    screen === undefined ? undefined : fitText(screen, tag, name);
  const diagonalText = inScreen("diagonal-length");
  const diagonal =
    diagonalText !== undefined && /^\d+(\.\d+)?$/.test(diagonalText)
      ? Number(diagonalText)
      : undefined;
  const folds =
    Number(inScreen("x-folded-dimension")) > 0 && Number(inScreen("y-folded-dimension")) > 0;
  const tablet =
    imageKind === undefined &&
    diagonal !== undefined &&
    diagonal >= TABLET_MIN_DIAGONAL_INCHES &&
    diagonal <= MAX_DIAGONAL_INCHES &&
    !folds;
  return { apiRange, imageKind, playStore, tablet };
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
  // `<d:ram unit="GiB">2</d:ram>`: the unit is an attribute, the number is the text.
  const ram = extractElement(deviceBlock, "ram");
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

/** Bytes per unit, for every value of the devices.xml schema's `storageUnitType`. */
const MEBIBYTE = 1024 ** 2;
const STORAGE_UNIT_BYTES: ReadonlyMap<string, number> = new Map([
  ["B", 1],
  ["KiB", 1024],
  ["MiB", MEBIBYTE],
  ["GiB", 1024 ** 3],
  ["TiB", 1024 ** 4],
]);

/**
 * The RAM in MiB, or undefined when it cannot be known: a missing or unknown unit (the schema
 * requires one), a value that is not a positive integer, or one that comes to under half a MiB
 * or past what a number counts exactly. Undefined leaves `hw.ramSize` unset rather than
 * guessing and writing a wrong size.
 */
function ramSizeToMebibytes(text: string, unit: string | undefined): number | undefined {
  const bytesPerUnit = unit === undefined ? undefined : STORAGE_UNIT_BYTES.get(unit.trim());
  if (bytesPerUnit === undefined || !/^\d+$/.test(text)) {
    return undefined;
  }
  const mebibytes = Math.round((Number(text) * bytesPerUnit) / MEBIBYTE);
  return mebibytes > 0 && Number.isSafeInteger(mebibytes) ? mebibytes : undefined;
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
):
  | {
      readonly attributes: Readonly<Record<string, string>>;
      readonly raw: string;
      readonly text: string;
    }
  | undefined {
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
  return { attributes, raw: match[2] ?? "", text: (match[2] ?? "").trim() };
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
