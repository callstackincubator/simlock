import { boundDriverSummary, DRIVER_DETAIL_MAX, parseOsConstraint } from "../contract/index.js";
import type { Config } from "./config.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  type Platform,
  transitionEnteredAt,
} from "./domain.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type {
  Driver,
  DriverCatalogEntry,
  DriverDevice,
  DriverRejection,
  MissingPrerequisite,
} from "./driver.js";
import { type DoctorFinding, key } from "./doctor-types.js";
import type { WarmTargetFigures } from "./warm-pool/index.js";

/**
 * why: A `reclaiming` record does not say which level started it -- every production path
 * asks for `standard`, but that is the caller's choice, not an invariant this finding can
 * depend on -- and the two errors are not symmetric: an estimate that is too tight turns a
 * healthy reclaim into a false stall finding, while one that is too loose only delays a real
 * one. So this takes the slower branch rather than assuming.
 */
function slowestReclaimEstimateMs(driver: Pick<Driver, "estimate">, spec: DeviceSpec): number {
  return Math.max(
    driver.estimate({ clean: "standard", operation: "reclaim" }, spec),
    driver.estimate({ clean: "full", operation: "reclaim" }, spec),
  );
}

/**
 * why: A `provisioning` / `reclaiming` device is normally in-flight work Simlock itself is
 * driving (see `expectedRunState`), not drift -- but only up to a point. Past a
 * driver-derived threshold it stops being "still working" and becomes a stall: the
 * driver call that was supposed to resolve it never did. This is a documented failure
 * mode, not a hypothetical one -- `DeviceProvisioner` deliberately leaves a device
 * `provisioning` when a boot-timeout's own cleanup `destroy` also fails ("The
 * registered record remains for reconcile when the driver cannot destroy it").
 *
 * The threshold is `driver.estimate(...) * thresholdMultiplier`, floored at
 * `minimumThresholdMs` (see `stallThresholdMs`): not `estimate` itself, because the
 * estimate is tuned for a routine run and real-world variance (a cold Android boot, a
 * loaded host) can legitimately run well past it without anything having stalled. No
 * driver for the device's platform, or no recorded entry time (defensive; see
 * `transitionEnteredAt`), means there is nothing to compare against, so no stall rather
 * than a guess.
 *
 * A device this daemon holds an operation claim on is excluded outright, before any
 * of that arithmetic: the claim *is* the statement that work is in progress, so a
 * live operation can never be read as a stall no matter how long it legitimately
 * runs. This is the same live-versus-orphaned test `StartupConverger
 * #recoverInterruptedReclaims` already makes, and it is load-bearing rather than
 * belt-and-braces -- every release now backgrounds its reclaim, holding the device in
 * `reclaiming` for a full erase, measured at ~34s, and several such erases run at once
 * and contend for the same disk. The estimate the threshold is built from now reflects
 * that erase rather than the 1s it used to claim (#56), but tuning a threshold against
 * contended disk speed would still be guessing; the claim answers it exactly. A reclaim
 * orphaned by a crash has no claim in the new process, so the case this test exists to
 * catch is untouched.
 */
export function isStalledTransition(input: StallInput): boolean {
  const { claims, config, device, driver, now } = input;
  if (device.state !== "provisioning" && device.state !== "reclaiming") {
    return false;
  }
  if (claims?.isClaimed(device.id) === true) {
    return false;
  }
  const enteredAt = transitionEnteredAt(device);
  if (enteredAt === undefined || driver === undefined) {
    return false;
  }
  return now - enteredAt > stallThresholdMs(device, driver, config);
}

export interface StallInput {
  readonly device: DeviceRecord;
  readonly driver: Pick<Driver, "estimate"> | undefined;
  readonly config: Config["stalledTransition"];
  readonly claims: Pick<DeviceOperationClaims, "isClaimed"> | undefined;
  readonly now: number;
}

function stallThresholdMs(
  device: DeviceRecord,
  driver: Pick<Driver, "estimate">,
  config: Config["stalledTransition"],
): number {
  const estimateMs =
    device.state === "provisioning"
      ? driver.estimate({ operation: "provision" }, device.spec) +
        driver.estimate({ operation: "boot" }, device.spec)
      : slowestReclaimEstimateMs(driver, device.spec);
  return Math.max(estimateMs * config.thresholdMultiplier, config.minimumThresholdMs);
}

export function stalledTransitionFinding(
  device: DeviceRecord,
  driversByPlatform: ReadonlyMap<Platform, Driver>,
  config: Config["stalledTransition"],
  now: number,
  claims?: Pick<DeviceOperationClaims, "isClaimed">,
): DoctorFinding | undefined {
  const driver = driversByPlatform.get(device.spec.platform);
  if (!isStalledTransition({ claims, config, device, driver, now })) {
    return undefined;
  }
  const enteredAt = transitionEnteredAt(device);
  if (
    driver === undefined ||
    enteredAt === undefined ||
    (device.state !== "provisioning" && device.state !== "reclaiming")
  ) {
    return undefined;
  }
  return {
    ageMs: now - enteredAt,
    deviceId: device.id,
    enteredAt,
    kind: "stalled-transition",
    platform: device.spec.platform,
    state: device.state,
    thresholdMs: stallThresholdMs(device, driver, config),
  };
}

/**
 * why: Discovery runs once, at daemon start, so a refusal is a frozen snapshot: repairing the
 * root and running `doctor` again reports the identical finding, because nothing has
 * looked at the root since. The finding therefore has to name the step that actually
 * retries the platform, or it reads as a repair that did not work.
 */
const DRIVER_RETRY_REMEDY =
  "Driver discovery runs once, at daemon startup: restart the daemon (`simlock daemon stop`, then any command relaunches it) once this is fixed, or the platform stays unavailable.";

export function driverUnavailableFindings(rejections: readonly DriverRejection[]): DoctorFinding[] {
  return rejections.map((rejection) => ({
    // why: a driver's summary is an error message of any length; the remedy is kept whole.
    detail: `${boundDriverSummary(rejection.summary, DRIVER_DETAIL_MAX - DRIVER_RETRY_REMEDY.length - 2)}. ${DRIVER_RETRY_REMEDY}`,
    kind: "driver-unavailable" as const,
    platform: rejection.platform,
    reason: rejection.reason,
  }));
}

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { android: "Android", ios: "iOS" };

function isRange(osVersion: string): boolean {
  const parsed = parseOsConstraint(osVersion);
  return parsed.ok && parsed.constraint.kind === "range";
}

// fallow-ignore-next-line complexity -- one finding per short reason, each a fixed message.
export function unreachableTarget(
  target: WarmTargetFigures,
  catalog: DriverCatalogEntry | undefined,
): DoctorFinding[] {
  const { model, osVersion, platform, short } = target;
  const named = [model, osVersion, target.mode].filter((part) => part !== undefined).join(" / ");
  const name = PLATFORM_NAMES[platform];
  if (short === "runtime-missing") {
    if (osVersion !== undefined && isRange(osVersion)) {
      return [
        {
          kind: "warm-pool-target-unreachable",
          message: `no installed ${name} runtime satisfies ${osVersion}`,
          platform,
          reason: short,
          remedy: `run simlock component list --platform ${platform} to see the versions, then simlock component install ${platform} <version> for one inside ${osVersion}`,
          target: named,
        },
      ];
    }
    if (
      model !== undefined &&
      osVersion !== undefined &&
      catalog?.runtimes.includes(osVersion) === true &&
      catalog.modelRuntimes[model] !== undefined &&
      !catalog.modelRuntimes[model].includes(osVersion)
    ) {
      return [
        {
          kind: "warm-pool-target-unreachable",
          message: `${model} does not pair with ${name} ${osVersion}`,
          platform,
          reason: short,
          remedy: `run simlock catalog --platform ${platform}`,
          target: named,
        },
      ];
    }
    return [
      {
        kind: "warm-pool-target-unreachable",
        message: `${name} ${osVersion ?? "runtime"} is not installed`,
        platform,
        reason: short,
        remedy:
          osVersion === undefined
            ? `run simlock component list --platform ${platform} to see the versions, then simlock component install ${platform} <version>`
            : `run simlock component install ${platform} ${osVersion}`,
        target: named,
      },
    ];
  }
  if (short === "unknown-model") {
    return [
      {
        kind: "warm-pool-target-unreachable",
        message: `${model} is not a known ${name} model`,
        platform,
        reason: short,
        remedy: `run simlock catalog --platform ${platform} to list the models`,
        target: named,
      },
    ];
  }
  return [];
}

export function overLimit(input: {
  readonly target: string;
  readonly sum: number;
  readonly limit: number;
  readonly reserve: number;
  readonly room: number;
  readonly scope: string;
  readonly platform?: Platform;
}): DoctorFinding {
  const { limit, platform, reserve, room, scope, sum, target } = input;
  const held = reserve > 0 ? `, of which warmPool.reserveRunning holds ${reserve}` : "";
  return {
    kind: "warm-pool-target-unreachable",
    message: `the ${scope}targets want ${sum} running devices, and the ${scope}running limit is ${limit}${held}, leaving room for ${room}`,
    reason: "over-limit",
    remedy: `lower the counts of the ${scope}warmPool.targets, ${reserve > 0 ? "" : "or "}raise the ${scope}running limit${reserve > 0 ? ", or lower warmPool.reserveRunning" : ""}`,
    target,
    ...(platform === undefined ? {} : { platform }),
  };
}

export function prerequisiteFindings(
  platform: Platform,
  missing: readonly MissingPrerequisite[],
  running: boolean,
  rejected: boolean,
): DoctorFinding[] {
  if (missing.length === 0) {
    return running || rejected
      ? []
      : [
          {
            kind: "prerequisite-missing",
            message: "Every prerequisite is present, but the daemon started without this platform.",
            platform,
            prerequisite: "daemon-restart",
            remedy: DRIVER_RETRY_REMEDY,
          },
        ];
  }
  return missing.map((found) => ({
    kind: "prerequisite-missing" as const,
    message: found.message,
    platform,
    prerequisite: found.prerequisite,
    remedy: running ? found.remedy : `${found.remedy} ${DRIVER_RETRY_REMEDY}`,
  }));
}

export function orphanFindings(
  realities: readonly {
    readonly driver: Driver;
    readonly reality: {
      readonly devices: readonly DriverDevice[];
      readonly processes: readonly DriverDevice[];
    };
  }[],
  registryDeviceKeys: ReadonlySet<string>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const { driver, reality } of realities) {
    for (const device of reality.devices) {
      if (!registryDeviceKeys.has(key(driver.platform, device.deviceId))) {
        findings.push({ device, kind: "orphan-device", platform: driver.platform });
      }
    }
    for (const device of reality.processes) {
      if (!registryDeviceKeys.has(key(driver.platform, device.deviceId))) {
        findings.push({ device, kind: "orphan-process", platform: driver.platform });
      }
    }
  }
  return findings;
}

export function expiredLeaseFindings(
  leases: readonly {
    readonly id: string;
    readonly deviceId: string;
    readonly ttlDeadline: number;
  }[],
  now: number,
): DoctorFinding[] {
  return leases
    .filter((lease) => lease.ttlDeadline <= now)
    .map((lease) => ({
      deviceId: lease.deviceId,
      kind: "expired-live-lease" as const,
      leaseId: lease.id,
    }));
}
