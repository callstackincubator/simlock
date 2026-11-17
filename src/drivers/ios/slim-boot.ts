import { join } from "node:path";
import { KeptCategoriesError, type DriverDevice, type DeviceMode } from "../../core/index.js";
import type { Clock, Filesystem, Logger } from "../../ports/index.js";

import { errorMessage } from "./command-run.js";

import { Simctl } from "./simctl.js";

import { iosRuntimeVersionFromId } from "./runtime-version.js";

import type { IosDriverConfig } from "./definition.js";
import {
  overridesFor,
  resolveSlimCategories,
  slimSignature,
  type SlimCategory,
} from "./slim-labels.js";
import { assertKeptEnabled, splitByExcept } from "./slim-except.js";

import { parseOverridesPlist, parsePrintDisabled, renderOverridesPlist } from "./slim-overrides.js";
import { type IosDriverData } from "./simulator-data.js";

// why: ADR 0060 §2: simslim's limit for a simulator just after its first boot.
const READBACK_TIMEOUT_MS = 120_000;
const OVERRIDES_FILE_NAME = "disabled.plist";
export const DEFAULT_OVERRIDES_ROOT = "/private/var/tmp";
const OVERRIDES_FOLDER_PREFIX = "com.apple.CoreSimulator.SimDevice.";

export interface SlimmedFact {
  readonly deviceId: string;
  readonly address: string;
  readonly categories: readonly string[];
  readonly labelCount: number;
  readonly durationMs: number;
  readonly signature: string;
  readonly unknownLabels: readonly string[];
}

export interface SlimSkippedFact {
  readonly deviceId: string;
  readonly reason: "runtime-too-old" | "unknown-runtime" | "apply-failed";
  readonly detail: string;
}

export type SlimOptions = IosDriverConfig["slim"];

type SlimWrite =
  | { readonly kind: "no-categories"; readonly detail: string }
  | {
      readonly kind: "written";
      readonly resolved: ReturnType<typeof resolveSlimCategories>;
      readonly wanted: ReadonlyMap<string, boolean>;
      readonly kept: readonly SlimCategory[];
      readonly startedAt: number;
      readonly writeError: string | undefined;
    };

type SlimPlan =
  | { readonly kind: "off" }
  | { readonly kind: "skip"; readonly reason: SlimSkippedFact["reason"]; readonly detail: string }
  | { readonly kind: "apply"; readonly slim: SlimOptions };

interface SlimBootOptions {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly fullBootTimeoutMs: number;
  readonly logger: Logger | undefined;
  readonly onSlimmed: ((fact: SlimmedFact) => void) | undefined;
  readonly onSlimSkipped: ((fact: SlimSkippedFact) => void) | undefined;
  readonly overridesRoot: string;
  readonly simctl: Simctl;
  readonly slim: SlimOptions | undefined;
}

/** why: the part of IosSimctlDriver (ADR 0060) that writes a simulator's launchd overrides so its managed services stay off, reads them back after the boot, and copies or removes them with the simulator. */
export class SlimBoot {
  readonly #clock: Clock;
  readonly #filesystem: Filesystem;
  readonly #fullBootTimeoutMs: number;
  readonly #logger: Logger | undefined;
  readonly #onSlimmed: ((fact: SlimmedFact) => void) | undefined;
  readonly #onSlimSkipped: ((fact: SlimSkippedFact) => void) | undefined;
  readonly #overridesRoot: string;
  readonly #simctl: Simctl;
  readonly #slim: SlimOptions | undefined;

  constructor(options: SlimBootOptions) {
    this.#clock = options.clock;
    this.#filesystem = options.filesystem;
    this.#fullBootTimeoutMs = options.fullBootTimeoutMs;
    this.#logger = options.logger;
    this.#onSlimmed = options.onSlimmed;
    this.#onSlimSkipped = options.onSlimSkipped;
    this.#overridesRoot = options.overridesRoot;
    this.#simctl = options.simctl;
    this.#slim = options.slim;
  }

  plan(
    data: IosDriverData,
    options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
  ): { readonly plan: SlimPlan; readonly bootstatusTimeoutMs: number } {
    return planSlimBoot(data, this.#slim, this.#fullBootTimeoutMs, options);
  }

  async settle(
    device: DriverDevice,
    data: IosDriverData,
    plan: SlimPlan,
    write: SlimWrite | undefined,
  ): Promise<DriverDevice> {
    if (plan.kind === "skip") {
      this.#onSlimSkipped?.({
        deviceId: device.deviceId,
        detail: plan.detail,
        reason: plan.reason,
      });
    }

    if (write === undefined) {
      return this.#asIs(device, data, "full");
    }
    if (write.kind === "no-categories") {
      return this.#skipApply(device, data, write.detail, "full");
    }

    return this.#readBack(device, data, write);
  }

  /** why: ADR 0060 §1: the slim file is in place before the copy's first boot, so the copy boots with what the seed was given. */
  async copyOverrides(seedUdid: string, copyUdid: string): Promise<void> {
    const from = join(this.#overridesFolder(seedUdid), OVERRIDES_FILE_NAME);
    try {
      if (!(await this.#filesystem.exists(from))) return;
      await this.#filesystem.mkdirp(this.#overridesFolder(copyUdid), { mode: 0o700 });
      await this.#filesystem.copyFile(
        from,
        join(this.#overridesFolder(copyUdid), OVERRIDES_FILE_NAME),
      );
    } catch (error: unknown) {
      this.#logger?.warn(
        `could not copy the launchd overrides of seed ${seedUdid} to ${copyUdid}: ${errorMessage(error)}`,
      );
    }
  }

  #asIs(device: DriverDevice, data: IosDriverData, mode: DeviceMode): DriverDevice {
    return {
      address: data.udid,
      deviceId: device.deviceId,
      driverData: device.driverData,
      mode,
    };
  }

  async writeOverrides(
    udid: string,
    slim: SlimOptions,
    except: readonly string[] = [],
  ): Promise<SlimWrite> {
    const configured = resolveSlimCategories(slim.categories);
    const { kept, resolved } = splitByExcept(configured, except);
    if (configured.categories.length === 0 && (slim.exclude ?? []).length === 0) {
      return {
        detail: `none of the configured slim categories (${(slim.categories ?? []).join(", ")}) are known`,
        kind: "no-categories",
      };
    }

    const startedAt = this.#clock.now();
    const wanted = overridesFor(resolved.categories, kept, {
      exclude: slim.exclude ?? [],
      include: slim.include ?? [],
      recorded: [],
    });
    let writeError: string | undefined;
    try {
      const folder = this.#overridesFolder(udid);
      const file = join(folder, OVERRIDES_FILE_NAME);
      const existing = await this.#readOverrides(file);
      const merged = new Map([...existing, ...wanted]);
      if (!sameEntries(existing, merged)) {
        await this.#filesystem.mkdirp(folder, { mode: 0o700 });
        await this.#filesystem.writeFileAtomic(file, renderOverridesPlist(merged), { mode: 0o644 });
      }
    } catch (error: unknown) {
      writeError = `could not write the launchd overrides file: ${errorMessage(error)}`;
    }

    return { kept, kind: "written", resolved, startedAt, wanted, writeError };
  }

  async #readOverrides(file: string): Promise<ReadonlyMap<string, boolean>> {
    if (!(await this.#filesystem.exists(file))) return new Map();
    const parsed = parseOverridesPlist(await this.#filesystem.readFile(file));
    if (parsed === undefined)
      throw new Error("the existing file is not a property list dictionary");
    return parsed;
  }

  #overridesFolder(udid: string): string {
    return join(this.#overridesRoot, `${OVERRIDES_FOLDER_PREFIX}${udid}`);
  }

  async #readBack(
    device: DriverDevice,
    data: IosDriverData,
    write: Extract<SlimWrite, { readonly kind: "written" }>,
  ): Promise<DriverDevice> {
    if (write.kept.length > 0 && write.writeError !== undefined) {
      throw new KeptCategoriesError(write.writeError);
    }
    const outcome = await this.#simctl.invoke(
      ["spawn", data.udid, "launchctl", "print-disabled", "system"],
      READBACK_TIMEOUT_MS,
    );
    const details = write.writeError === undefined ? [] : [write.writeError];

    if (outcome.kind === "timed-out" || outcome.result.code !== 0) {
      details.push(`could not read back the launchd overrides: ${readBackFailure(outcome)}`);
      if (write.kept.length > 0) throw new KeptCategoriesError(details.join("; "));
      return this.#skipApply(device, data, details.join("; "), "slim");
    }
    return this.#judgeReadBack(device, data, write, details, outcome.result.stdout);
  }

  #judgeReadBack(
    device: DriverDevice,
    data: IosDriverData,
    write: Extract<SlimWrite, { readonly kind: "written" }>,
    details: string[],
    stdout: string,
  ): DriverDevice {
    const read = parsePrintDisabled(stdout);
    assertKeptEnabled(write.kept, read);
    const mismatched = [...write.wanted.keys()]
      .sort()
      .filter((label) => (read.get(label) ?? false) !== write.wanted.get(label));
    if (mismatched.length > 0) {
      details.push(
        `${String(mismatched.length)} of ${String(write.wanted.size)} managed labels did not read back as written at boot; first: ${mismatched[0] ?? ""}`,
      );
      return this.#skipApply(device, data, details.join("; "), "full");
    }
    if (details.length > 0) {
      return this.#skipApply(device, data, details.join("; "), "slim");
    }

    // why: nothing written off (an except list naming the whole slim set, or an include covering it) slims nothing: full, no `device.slimmed` (ADR 0083 §4).
    if (![...write.wanted.values()].some(Boolean)) return this.#asIs(device, data, "full");
    this.#reportSlimmed(device, data, write);
    return this.#asIs(device, data, "slim");
  }

  #reportSlimmed(
    device: DriverDevice,
    data: IosDriverData,
    write: Extract<SlimWrite, { readonly kind: "written" }>,
  ): void {
    this.#onSlimmed?.({
      address: data.udid,
      categories: write.resolved.categories.map((category) => category.name),
      deviceId: device.deviceId,
      durationMs: this.#clock.now() - write.startedAt,
      labelCount: [...write.wanted.values()].filter(Boolean).length,
      signature: slimSignature(write.resolved.categories),
      unknownLabels: [...write.resolved.unknown],
    });
  }

  #skipApply(
    device: DriverDevice,
    data: IosDriverData,
    detail: string,
    mode: DeviceMode,
  ): DriverDevice {
    this.#onSlimSkipped?.({ deviceId: device.deviceId, detail, reason: "apply-failed" });
    return this.#asIs(device, data, mode);
  }

  // why: simctl delete leaves the folder behind; a failed removal must not fail a destroy that
  // already deleted the simulator.
  async removeOverrides(udid: string): Promise<void> {
    try {
      await this.#filesystem.rm(this.#overridesFolder(udid));
    } catch (error: unknown) {
      this.#logger?.warn(
        `could not remove the launchd overrides folder of ${udid}: ${errorMessage(error)}`,
      );
    }
  }
}

export function supportsPersistentSlim(version: readonly [number, number] | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor] = version;
  return major > 18 || (major === 18 && minor >= 5);
}

function planSlimBoot(
  data: IosDriverData,
  slim: SlimOptions | undefined,
  fullBootTimeoutMs: number,
  options: { readonly purpose: "prepare" | "recover"; readonly mode: DeviceMode },
): { readonly plan: SlimPlan; readonly bootstatusTimeoutMs: number } {
  if (options.purpose === "recover" || slim === undefined || options.mode !== "slim") {
    return { bootstatusTimeoutMs: fullBootTimeoutMs, plan: { kind: "off" } };
  }

  const version = iosRuntimeVersionFromId(data.runtimeId);
  if (!supportsPersistentSlim(version)) {
    return {
      bootstatusTimeoutMs: fullBootTimeoutMs,
      plan: {
        detail:
          version === undefined
            ? `runtimeId "${data.runtimeId}" does not parse to an iOS version`
            : `iOS ${String(version[0])}.${String(version[1])} is below the 18.5 persistent-override floor`,
        kind: "skip",
        reason: version === undefined ? "unknown-runtime" : "runtime-too-old",
      },
    };
  }

  return { bootstatusTimeoutMs: slim.bootTimeoutMs, plan: { kind: "apply", slim } };
}

function sameEntries(a: ReadonlyMap<string, boolean>, b: ReadonlyMap<string, boolean>): boolean {
  return a.size === b.size && [...a].every(([label, disabled]) => b.get(label) === disabled);
}

function readBackFailure(
  outcome:
    | { readonly kind: "timed-out" }
    | { readonly kind: "finished"; readonly result: { code: number | null; stderr: string } },
): string {
  return outcome.kind === "timed-out"
    ? `timed out after ${String(READBACK_TIMEOUT_MS)}ms`
    : `exit ${String(outcome.result.code)}: ${outcome.result.stderr.trim()}`;
}
