import type { EventBus } from "../bus/index.js";
import { boundDriverSummary, DRIVER_DETAIL_MAX, parseOsConstraint } from "../contract/index.js";
import { type Clock, type Logger, NoopLogger } from "../ports/index.js";
import type { Config } from "./config.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  type DeviceState,
  mayBeGranted,
  type Platform,
  transitionEnteredAt,
  type VirtualDevice,
} from "./domain.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type { StartupRead } from "./startup-read.js";
import {
  type Driver,
  type DriverCatalogEntry,
  type DriverDevice,
  type DriverRejection,
  type DriverReality,
  type DriverRejectionReason,
  type MissingPrerequisite,
  type ObservedDevice,
  type ObservedMark,
  type PrerequisiteCheck,
  virtualDriverDevice,
} from "./driver.js";
import type { CapacityReader, LeaseExpirer, WarmPoolReader } from "./core-ports.js";
import { reservedRunning, type WarmTargetFigures } from "./warm-pool/index.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";

export type DoctorFinding =
  | {
      readonly kind: "registry-device-missing";
      readonly deviceId: string;
      readonly platform: Platform;
    }
  | { readonly kind: "orphan-device"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "orphan-process"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "expired-live-lease"; readonly leaseId: string; readonly deviceId: string }
  | {
      readonly kind: "foreign-state-change";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly expected: "running" | "stopped";
      readonly observed: "running" | "stopped";
    }
  | {
      readonly kind: "foreign-provenance-change";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly detail: ProvenanceDrift;
    }
  | {
      readonly kind: "driver-unavailable";
      readonly platform: Platform;
      readonly reason: DriverRejectionReason;
      readonly detail: string;
    }
  | {
      readonly kind: "legacy-device";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly device: DriverDevice;
      readonly path?: string;
    }
  | {
      readonly kind: "stalled-transition";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly state: "provisioning" | "reclaiming";
      readonly enteredAt: number;
      readonly ageMs: number;
      readonly thresholdMs: number;
    }
  | {
      readonly kind: "driver-advisory";
      readonly platform: Platform;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "prerequisite-missing";
      readonly platform: Platform;
      readonly prerequisite: string;
      readonly message: string;
      readonly remedy: string;
    }
  | {
      /**
       * why: the worker's login service names a Node or `main.js` that is gone. Like
       * `driver-advisory` it is not drift: `--fix` never acts on it, and `doctor.reconciled` does not carry it.
       */
      readonly kind: "service-broken";
      readonly manager: "launchd" | "systemd";
      readonly name: string;
      readonly missing: readonly string[];
      readonly remedy: string;
    }
  | {
      readonly kind: "warm-pool-target-unreachable";
      readonly platform?: Platform;
      readonly target: string;
      readonly reason: "runtime-missing" | "unknown-model" | "over-limit";
      readonly message: string;
      readonly remedy: string;
    }
  | {
      readonly kind: "module-unavailable";
      readonly module: string;
      readonly message: string;
      readonly remedy: string;
    };

/**
 * why: the service manager's answer for this role's service, injected so the core checks no path
 * itself; `check` returns the paths the service names that are gone, none when whole or absent.
 */
export interface ServiceCheck {
  readonly manager: "launchd" | "systemd";
  readonly name: string;
  readonly check: () => Promise<readonly string[]>;
}

export type OptionalModuleFinding = Extract<DoctorFinding, { readonly kind: "module-unavailable" }>;

export type ProvenanceDrift = "erased" | "mark-mismatch" | "durable-mark-missing";

type OrphanDeviceFinding = Extract<DoctorFinding, { readonly kind: "orphan-device" }>;

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorQuarantine {
  enterFromStalledTransition(deviceId: string, findingState: DeviceState): Promise<boolean>;
}

export interface DoctorOptions {
  readonly clock: Clock;
  readonly config: Config;
  /**
   * why: The decision section every registry write of this daemon is made in. A write made outside it
   * can land on top of a concurrent one that read the registry before it, and undo it.
   */
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly leaseExpirer?: LeaseExpirer;
  readonly quarantine?: DoctorQuarantine;
  readonly claims?: Pick<DeviceOperationClaims, "isClaimed">;
  readonly driverRejections?: readonly DriverRejection[];
  readonly logger?: Logger;
  readonly optionalModules?: () => readonly OptionalModuleFinding[];
  readonly warmPool?: {
    readonly figures: WarmPoolReader["figures"];
    readonly runningCapacity: () => CapacityReader["runningCapacity"];
  };
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
  readonly serviceCheck?: ServiceCheck;
  readonly runningPlatforms?: () => readonly Platform[];
  readonly registry: Registry;
}

export interface DoctorReconcileOptions {
  readonly fix?: boolean;
  readonly read?: StartupRead;
  /**
   * why: deliberately not part of `fix`: someone already running `doctor --fix` unattended in
   * CI must not acquire a destructive behaviour by upgrading (ADR 0001, decision 6).
   */
  readonly purgeOrphans?: boolean;
  readonly prerequisites?: boolean;
}

export class Doctor {
  readonly #logger: Logger;

  constructor(private readonly options: DoctorOptions) {
    this.#logger = options.logger?.child("doctor") ?? new NoopLogger();
  }

  async reconcile({
    fix = false,
    purgeOrphans = false,
    prerequisites = false,
    read,
  }: DoctorReconcileOptions = {}): Promise<DoctorReport> {
    const snapshot = this.options.registry.snapshot;
    const realities = await this.#realities(read);
    // why: A platform with no driver has no observable reality: its driver refused to start,
    // its SDK is missing, or this host has none. The same holds for a platform the startup
    // read could not list. "I could not look" is not "the device is
    // gone", and reading it as such is destructive -- every registry device of that
    // platform would drift-report as missing and `--fix` would mark the lot `deleted`,
    // stranding tens of gigabytes of simulators in a root with no record left to reach
    // them. That is the permanent leak ADR 0001 exists to prevent, so existence, run
    // state, provenance and orphans are all reported only for platforms a driver
    // actually observed. What remains reportable is what needs no driver: expired
    // leases, and the `driver-unavailable` finding that says why the platform is dark.
    const observedPlatforms = new Set(realities.map(({ driver }) => driver.platform));
    const realDeviceKeys = new Set(
      realities.flatMap(({ driver, reality }) =>
        reality.devices.map((device) => key(driver.platform, device.deviceId)),
      ),
    );
    const observedDevices = new Map<string, ObservedDevice>(
      realities.flatMap(({ driver, reality }) =>
        reality.devices.map((device) => [key(driver.platform, device.deviceId), device] as const),
      ),
    );
    const registryDeviceKeys = new Set(
      snapshot.devices.map((device) => key(device.spec.platform, device.driverDeviceId)),
    );
    const driversByPlatform = new Map(
      this.options.drivers.map((driver) => [driver.platform, driver]),
    );
    const findings: DoctorFinding[] = [];

    findings.push(
      ...(await this.#driftFindings(snapshot.virtualDevices, {
        driversByPlatform,
        observedDevices,
        observedPlatforms,
        realDeviceKeys,
      })),
    );
    findings.push(...this.#stalledFindings(snapshot.devices, driversByPlatform));
    findings.push(...driverUnavailableFindings(this.options.driverRejections ?? []));
    findings.push(...orphanFindings(realities, registryDeviceKeys));
    findings.push(...expiredLeaseFindings(snapshot.leases, this.options.clock.now()));
    findings.push(...(await this.#collectAdvisories()));

    this.#emitStalledEvents(findings);
    if (fix) {
      await this.#applySafeFixes(findings, driversByPlatform);
    }
    // why: Prerequisites last: a check may run for tens of seconds, and nothing `--fix` or a purge
    // acts on should wait behind it and go stale. They are never acted on themselves.
    const remaining = [
      ...(purgeOrphans ? await this.#purgeOrphans(findings, driversByPlatform) : findings),
      ...(await this.#collectPrerequisites(prerequisites)),
      ...(await this.#serviceFindings()),
      ...(await this.#warmPoolFindings()),
      ...this.#optionalModuleFindings(),
    ];

    const report = { findings: remaining };
    this.#emitFindingEvents(remaining);
    this.options.eventBus.emit(
      "doctor.reconciled",
      {
        // why: `driftFindings` means things `--fix` might correct;
        // advisory and prerequisite findings are not drift, so they stay out of this payload.
        driftFindings: remaining.filter(isDrift),
      },
      "doctor",
    );
    return report;
  }

  async #realities(
    read: StartupRead | undefined,
  ): Promise<readonly { readonly driver: Driver; readonly reality: DriverReality }[]> {
    if (read === undefined) {
      return Promise.all(
        this.options.drivers.map(async (driver) => ({
          driver,
          reality: await driver.listManaged(),
        })),
      );
    }
    return this.options.drivers.flatMap((driver) => {
      const reality = read.reality(driver.platform);
      return reality === undefined ? [] : [{ driver, reality }];
    });
  }

  /**
   * why: This is the one place Simlock destroys something the registry has never heard of, and
   * the residual risk is accepted rather than mitigated: an orphan has no registry record,
   * so no central safety filter and no `DeviceOperationClaims` entry can protect it --
   * including a device this very daemon is between `driver.provision` and
   * `registry.registerDevice` on, which is precisely the window that creates orphans in the
   * first place. Nothing here can tell that device apart from the leak it looks like. That
   * is why the command is opt-in, confirmed, and unreachable from the reaper, a cleanup
   * rule, an idle tier or `--fix` (safety rule 1) -- not an oversight to be "fixed" later
   * by wiring it into something automatic.
   *
   * A destroy that fails is logged and leaves its finding standing: the orphan is still
   * there to report, and one unlucky device must not cost the rest of the run.
   */
  async #purgeOrphans(
    findings: readonly DoctorFinding[],
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): Promise<readonly DoctorFinding[]> {
    const orphans = findings.filter(
      (finding): finding is OrphanDeviceFinding => finding.kind === "orphan-device",
    );
    if (orphans.length === 0 || !(await this.#rootsStillProven(orphans, driversByPlatform))) {
      return findings;
    }

    const purged = new Set<string>();
    for (const orphan of orphans) {
      const driver = driversByPlatform.get(orphan.platform);
      if (driver === undefined) continue;
      try {
        await driver.destroy(virtualDriverDevice(orphan.device));
      } catch (error: unknown) {
        this.#logger.error("Could not purge orphan device", {
          deviceId: orphan.device.deviceId,
          platform: orphan.platform,
          reason: errorMessage(error),
        });
        continue;
      }
      purged.add(key(orphan.platform, orphan.device.deviceId));
      this.options.eventBus.emit(
        "device.orphan-purged",
        {
          deviceRoot: driver.deviceRoot,
          driverDeviceId: orphan.device.deviceId,
          platform: orphan.platform,
        },
        "doctor",
      );
    }

    // why: An `orphan-process` for a device that is now gone is gone with it: destroying the
    // device covers the process it was running, so reporting both would ask the operator
    // to deal with something that no longer exists.
    return findings.filter(
      (finding) =>
        !(
          (finding.kind === "orphan-device" || finding.kind === "orphan-process") &&
          purged.has(key(finding.platform, finding.device.deviceId))
        ),
    );
  }

  /**
   * why: The proof a purge acts on is the one taken at startup, and the thing it authorises is
   * recomputed on every reconcile: a root replaced by a symlink, or a `mv` that leaves the
   * user's own device set at the configured path, turns `listManaged` into a claim over
   * their simulators and this command into the thing that deletes them. Reporting can live
   * with a stale proof; destroying cannot.
   *
   * A refusal aborts the whole purge rather than the one platform: the roots are validated
   * before anything is destroyed, so an abort costs a re-run and never a half-purge, and a
   * daemon that cannot prove one of its roots is not a daemon to keep destroying on.
   */
  async #rootsStillProven(
    orphans: readonly OrphanDeviceFinding[],
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): Promise<boolean> {
    const platforms = new Set(orphans.map((orphan) => orphan.platform));
    for (const platform of platforms) {
      const driver = driversByPlatform.get(platform);
      if (driver === undefined) continue;
      try {
        await driver.revalidateRoot();
      } catch (error: unknown) {
        this.#logger.error(
          "Refusing to purge orphans: the device root no longer proves ownership",
          {
            deviceRoot: driver.deviceRoot,
            platform,
            reason: errorMessage(error),
          },
        );
        return false;
      }
    }
    return true;
  }

  /**
   * why: Registry versus root, per device: existence, run state and provenance. Drift compares the
   * registry with what a root holds, so it reads virtual devices only: a physical record is in
   * no root and would read as missing.
   */
  async #driftFindings(
    devices: readonly VirtualDevice[],
    reality: {
      readonly driversByPlatform: ReadonlyMap<Platform, Driver>;
      readonly observedDevices: ReadonlyMap<string, ObservedDevice>;
      readonly observedPlatforms: ReadonlySet<Platform>;
      readonly realDeviceKeys: ReadonlySet<string>;
    },
  ): Promise<DoctorFinding[]> {
    const findings: DoctorFinding[] = [];
    for (const device of devices) {
      if (!reality.observedPlatforms.has(device.spec.platform)) continue;
      const deviceFindings = await this.#withLegacyDevice(
        device,
        registryDriftFindings(
          device,
          reality.realDeviceKeys,
          reality.observedDevices,
          this.options.claims,
        ),
        reality.driversByPlatform.get(device.spec.platform),
      );
      findings.push(...deviceFindings);
      if (deviceFindings.some((finding) => finding.kind === "foreign-state-change")) {
        await this.options.decisions.run(() =>
          this.options.registry.markForeignStateDetected(device.id, this.options.clock.now()),
        );
      }
      if (deviceFindings.some((finding) => finding.kind === "foreign-provenance-change")) {
        await this.options.decisions.run(() =>
          this.options.registry.markForeignProvenanceDetected(device.id, this.options.clock.now()),
        );
      }
    }
    return findings;
  }

  #stalledFindings(
    devices: readonly DeviceRecord[],
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): DoctorFinding[] {
    return devices.flatMap((device) => {
      const stalled = stalledTransitionFinding(
        device,
        driversByPlatform,
        this.options.config.stalledTransition,
        this.options.clock.now(),
        this.options.claims,
      );
      return stalled === undefined ? [] : [stalled];
    });
  }

  /**
   * why: A driver that cannot answer -- no legacy location, or a lookup that failed -- leaves
   * the original finding alone. `registry-device-missing` is the conservative of the two:
   * its fix only writes to the registry, while the legacy fix destroys.
   */
  async #withLegacyDevice(
    device: DeviceRecord,
    findings: readonly DoctorFinding[],
    driver: Driver | undefined,
  ): Promise<readonly DoctorFinding[]> {
    const findLegacy = driver?.findLegacy?.bind(driver);
    if (findLegacy === undefined || !findings.some((f) => f.kind === "registry-device-missing")) {
      return findings;
    }

    let legacy;
    try {
      legacy = await findLegacy(device.driverDeviceId);
    } catch (error: unknown) {
      this.#logger.warn("Could not look for a pre-root copy of a missing device", {
        deviceId: device.id,
        platform: device.spec.platform,
        reason: errorMessage(error),
      });
      return findings;
    }
    if (legacy === undefined) return findings;

    return findings.map((finding) =>
      finding.kind === "registry-device-missing"
        ? {
            device: legacy.device,
            deviceId: device.id,
            kind: "legacy-device" as const,
            platform: device.spec.platform,
            ...(legacy.path === undefined ? {} : { path: legacy.path }),
          }
        : finding,
    );
  }

  async #collectAdvisories(): Promise<DoctorFinding[]> {
    const perDriver = await Promise.all(
      this.options.drivers.map(async (driver): Promise<DoctorFinding[]> => {
        if (driver.advisories === undefined) {
          return [];
        }
        try {
          const advisories = await driver.advisories();
          return advisories.map((advisory) => ({
            code: advisory.code,
            kind: "driver-advisory" as const,
            message: advisory.message,
            platform: driver.platform,
          }));
        } catch {
          return [];
        }
      }),
    );
    return perDriver.flat();
  }

  /**
   * why: Driver discovery, though, ran once at startup. So a platform that is not running gets the
   * restart sentence on each finding, and one whose prerequisites are all present gets a
   * finding of its own that says so -- unless its driver was refused, which `driver-unavailable`
   * already explains.
   */
  async #collectPrerequisites(enabled: boolean): Promise<DoctorFinding[]> {
    if (!enabled) return [];
    const running = new Set(
      this.options.runningPlatforms?.() ?? this.options.drivers.map((driver) => driver.platform),
    );
    const rejected = new Set(
      (this.options.driverRejections ?? []).map((rejection) => rejection.platform),
    );
    const perCheck = await Promise.all(
      (this.options.prerequisiteChecks ?? []).map(async (check): Promise<DoctorFinding[]> => {
        let missing: readonly MissingPrerequisite[];
        try {
          missing = await check.check();
        } catch (error: unknown) {
          this.#logger.warn("Could not check platform prerequisites", {
            platform: check.platform,
            reason: errorMessage(error),
          });
          return [];
        }
        return prerequisiteFindings(
          check.platform,
          missing,
          running.has(check.platform),
          rejected.has(check.platform),
        );
      }),
    );
    return perCheck.flat();
  }

  /** why: a check that rejects could not tell, so it is logged and contributes nothing. */
  async #serviceFindings(): Promise<DoctorFinding[]> {
    const { serviceCheck } = this.options;
    if (serviceCheck === undefined) return [];
    let missing: readonly string[];
    try {
      missing = await serviceCheck.check();
    } catch (error: unknown) {
      this.#logger.warn("Could not check the login service", {
        name: serviceCheck.name,
        reason: errorMessage(error),
      });
      return [];
    }
    if (missing.length === 0) return [];
    return [
      {
        kind: "service-broken",
        manager: serviceCheck.manager,
        name: serviceCheck.name,
        missing,
        remedy: "Run `simlock daemon install` again.",
      },
    ];
  }

  #optionalModuleFindings(): readonly OptionalModuleFinding[] {
    try {
      return this.options.optionalModules?.() ?? [];
    } catch (error) {
      this.#logger.warn("Could not read optional module findings", {
        error: errorMessage(error),
      });
      return [];
    }
  }

  async #catalogsOfMissingRuntimes(
    targets: readonly WarmTargetFigures[],
  ): Promise<Map<Platform, DriverCatalogEntry>> {
    const catalogs = new Map<Platform, DriverCatalogEntry>();
    const platforms = new Set(
      targets.filter((target) => target.short === "runtime-missing").map((t) => t.platform),
    );
    for (const driver of this.options.drivers) {
      if (!platforms.has(driver.platform)) continue;
      try {
        catalogs.set(driver.platform, await driver.listCatalog());
      } catch (error) {
        this.#logger.warn("Could not read a catalog for a warm pool finding", {
          error: errorMessage(error),
          platform: driver.platform,
        });
      }
    }
    return catalogs;
  }

  /**
   * why: the warm pool's configured targets (a learned kind is never a finding) that cannot be met: those the last pass found a runtime
   * or a model missing for, and the platforms (or the machine) whose targets add up to more than
   * the running limit leaves once the reserve is held back. Read, never acted on, like
   * `prerequisite-missing`. A target short for RAM, the device limit or a failed boot is no
   * finding: those pass with time or with an operator's choice of machine. None with the pool off.
   */
  async #warmPoolFindings(): Promise<DoctorFinding[]> {
    const { warmPool } = this.options;
    const { enabled, targets } = this.options.config.warmPool;
    if (warmPool === undefined || !enabled) return [];
    const limits = warmPool.runningCapacity();
    const figures = warmPool.figures().targets.filter((target) => target.origin === "configured");
    const catalogs = await this.#catalogsOfMissingRuntimes(figures);
    const findings = figures.flatMap((target) =>
      unreachableTarget(target, catalogs.get(target.platform)),
    );
    const reserves = reservedRunning(this.options.config.warmPool, limits);
    let wanted = 0;
    for (const platform of ["ios", "android"] as const) {
      const sum = targets
        .filter((target) => target.platform === platform)
        .reduce((total, target) => total + target.count, 0);
      const reserve = reserves[platform];
      const available = limits[platform].maxRunning - reserve;
      wanted += sum;
      if (sum > available) {
        findings.push(
          overLimit({
            limit: limits[platform].maxRunning,
            platform,
            reserve,
            room: available,
            scope: `${platform} `,
            sum,
            target: `${platform} targets`,
          }),
        );
      }
    }
    // why: The machine's reserve cannot hold more slots than the machine has: a figure past the limit
    // would print a room below zero, and with no target there is nothing to report.
    const reserved = Math.min(reserves.ios + reserves.android, limits.global.maxRunning);
    const room = limits.global.maxRunning - reserved;
    if (wanted > room) {
      findings.push(
        overLimit({
          limit: limits.global.maxRunning,
          reserve: reserved,
          room,
          scope: "",
          sum: wanted,
          target: "all targets",
        }),
      );
    }
    return findings;
  }

  #emitFindingEvents(findings: readonly DoctorFinding[]): void {
    for (const finding of findings) {
      if (finding.kind === "foreign-state-change") {
        this.options.eventBus.emit(
          "device.foreign-state-detected",
          {
            deviceId: finding.deviceId,
            expected: finding.expected,
            observed: finding.observed,
            platform: finding.platform,
          },
          "doctor",
        );
      }
      if (finding.kind === "foreign-provenance-change") {
        this.options.eventBus.emit(
          "device.foreign-provenance-detected",
          { detail: finding.detail, deviceId: finding.deviceId, platform: finding.platform },
          "doctor",
        );
      }
    }
  }

  /**
   * why: announced as soon as the read finds it, before `--fix` acts: a stall is not a commit, and the
   * fix re-reads the device under its claim, so a reclaim that starts in between is left alone.
   */
  #emitStalledEvents(findings: readonly DoctorFinding[]): void {
    for (const finding of findings) {
      if (finding.kind !== "stalled-transition") continue;
      this.options.eventBus.emit(
        "device.stalled-transition-detected",
        {
          ageMs: finding.ageMs,
          deviceId: finding.deviceId,
          platform: finding.platform,
          state: finding.state,
          thresholdMs: finding.thresholdMs,
        },
        "doctor",
      );
    }
  }

  async #applySafeFixes(
    findings: readonly DoctorFinding[],
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): Promise<void> {
    for (const finding of findings) {
      await this.#applySafeFix(finding, driversByPlatform);
    }
  }

  // fallow-ignore-next-line complexity -- one exhaustive arm per finding kind, each a single call or a documented no-op.
  async #applySafeFix(
    finding: DoctorFinding,
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): Promise<void> {
    switch (finding.kind) {
      case "registry-device-missing":
        await this.options.decisions.run(() => this.#fixMissingDevice(finding.deviceId));
        break;
      case "orphan-device":
      case "orphan-process":
        break;
      case "expired-live-lease":
        if (this.options.leaseExpirer !== undefined) {
          await this.options.leaseExpirer.expire(finding.leaseId);
        }
        break;
      case "foreign-state-change":
        await this.options.decisions.run(() => this.#fixForeignStateChange(finding));
        break;
      case "foreign-provenance-change":
        // why: Report-only: re-marking destroys the evidence, and the device may be leased.
        break;
      case "driver-unavailable":
        // why: Nothing here can repair a refused root or an occupied port without doing the
        // one thing failing closed exists to prevent: adopting what it refused.
        break;
      case "legacy-device":
        await this.#fixLegacyDevice(finding, driversByPlatform.get(finding.platform));
        break;
      case "stalled-transition":
        await this.#fixStalledTransition(finding);
        break;
      case "driver-advisory":
        break;
      case "prerequisite-missing":
        break;
      case "service-broken":
        // why: installing again is the operator's call: `--fix` never rewrites the service.
        break;
    }
  }

  async #fixMissingDevice(deviceId: string): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === deviceId)) {
      return;
    }
    await this.options.registry.markDeviceMissing(deviceId, "doctor");
  }

  /**
   * why: The destroy reaches outside the driver's root, which every other path in Simlock is
   * forbidden to do -- and is permitted here for one reason: the device is in the registry.
   * Registry-only destruction (safety rule 1) is a rule about *what may be destroyed*, and
   * a registry record satisfies it exactly as a root membership would; the record is also
   * the only thing that names this device at all. The lease guard every other fix applies
   * still applies, first and hardest, because the device is real and someone may be on it.
   *
   * The registry record is only marked missing once the device is actually gone. Marking it
   * first would strand the device: the record naming it would be `deleted` and nothing would
   * ever mention its old path again.
   */
  async #fixLegacyDevice(
    finding: Extract<DoctorFinding, { readonly kind: "legacy-device" }>,
    driver: Driver | undefined,
  ): Promise<void> {
    const destroyLegacy = driver?.destroyLegacy?.bind(driver);
    if (destroyLegacy === undefined) return;
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
      return;
    }
    try {
      await destroyLegacy(virtualDriverDevice(finding.device));
    } catch (error: unknown) {
      this.#logger.error("Could not destroy a pre-root device", {
        deviceId: finding.deviceId,
        platform: finding.platform,
        reason: errorMessage(error),
      });
      return;
    }
    await this.options.decisions.run(() => this.#fixMissingDevice(finding.deviceId));
  }

  async #fixForeignStateChange(
    finding: Extract<DoctorFinding, { readonly kind: "foreign-state-change" }>,
  ): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === finding.deviceId);
    if (device === undefined) {
      return;
    }
    // why: Only `ready` and `shutdown` have a legal transition to the opposite run state. A
    // device recorded as `leased` with no lease record reaches here past the lease guard
    // above; correcting it would throw IllegalTransition and abort the whole reconcile,
    // so leave it to the report rather than crashing the reaper tick.
    if (device.state === "ready" && finding.observed === "stopped") {
      await this.options.registry.transitionDevice(finding.deviceId, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: finding.deviceId, initiator: "doctor" },
      });
    } else if (
      device.state === "shutdown" &&
      finding.observed === "running" &&
      // why: A spent fresh device stays `shutdown`, running or not: every path that deletes it
      // selects `shutdown`, and the delete stops a running simulator first. Moving it to
      // `ready` would strand it as ungrantable warm inventory that nothing deletes.
      mayBeGranted(device)
    ) {
      await this.options.registry.transitionDevice(finding.deviceId, "ready", {
        event: "device.ready",
        payload: { bootDuration: 0, deviceId: finding.deviceId },
      });
    } else {
      return;
    }
    await this.options.registry.clearForeignStateDetected(finding.deviceId);
  }

  async #fixStalledTransition(
    finding: Extract<DoctorFinding, { readonly kind: "stalled-transition" }>,
  ): Promise<void> {
    // why: A device this finding targets is never `leased` -- that's a separate state
    // entirely -- but the guard is kept anyway, matching every other fix here, so a
    // future change to what produces this finding can never reach a leased device.
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === finding.deviceId);
    if (device === undefined || device.state !== finding.state) {
      return;
    }
    if (this.options.quarantine === undefined) {
      return;
    }
    await this.options.quarantine.enterFromStalledTransition(finding.deviceId, finding.state);
  }
}

function registryDriftFindings(
  device: DeviceRecord,
  realDeviceKeys: ReadonlySet<string>,
  observedDevices: ReadonlyMap<string, ObservedDevice>,
  claims?: Pick<DeviceOperationClaims, "isClaimed">,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const deviceKey = key(device.spec.platform, device.driverDeviceId);

  const missing = missingDeviceFinding(device, deviceKey, realDeviceKeys);
  if (missing !== undefined) {
    findings.push(missing);
  }

  // why: `expected === undefined` means the registry is mid-transition: simlock is acting on the device
  // itself, so neither run state nor marks are compared.
  //
  // A device this daemon holds an operation claim on is excluded too: a lease-path boot from
  // `shutdown` runs `makeReady` while the record still says `shutdown`, and a concurrent
  // `doctor --fix` would read that as foreign drift, "fix" the record, and make the boot's own
  // commit drop its `address`/`driverData`/`mode`.
  const expected = expectedRunState(device.state);
  const observed = observedDevices.get(deviceKey);
  const claimed = claims?.isClaimed(device.id) === true;
  if (expected !== undefined && observed !== undefined && !claimed) {
    findings.push(...liveDriftFindings(device, expected, observed));
  }

  return findings;
}

function missingDeviceFinding(
  device: DeviceRecord,
  deviceKey: string,
  realDeviceKeys: ReadonlySet<string>,
): DoctorFinding | undefined {
  if (device.state === "deleted" || realDeviceKeys.has(deviceKey)) {
    return undefined;
  }
  return { deviceId: device.id, kind: "registry-device-missing", platform: device.spec.platform };
}

function liveDriftFindings(
  device: DeviceRecord,
  expected: "running" | "stopped",
  observed: ObservedDevice,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  if (observed.runState !== "transitioning" && observed.runState !== expected) {
    findings.push({
      deviceId: device.id,
      expected,
      kind: "foreign-state-change",
      observed: observed.runState,
      platform: device.spec.platform,
    });
  }

  const detail = observed.mark === undefined ? undefined : provenanceDrift(observed.mark);
  if (detail !== undefined) {
    findings.push({
      detail,
      deviceId: device.id,
      kind: "foreign-provenance-change",
      platform: device.spec.platform,
    });
  }

  return findings;
}

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

function stalledTransitionFinding(
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
 * why: Report-only by design. Re-marking would overwrite the only evidence that the
 * device was tampered with, and a fresh mark cannot be written to a leased
 * device without disturbing its holder -- so the core never repairs a mark.
 */
function provenanceDrift(mark: ObservedMark): ProvenanceDrift | undefined {
  if (mark.durable === undefined) {
    return "durable-mark-missing";
  }
  if (!mark.erasableReadable) {
    return undefined;
  }
  if (mark.erasable === undefined) {
    return "erased";
  }
  return mark.erasable === mark.durable ? undefined : "mark-mismatch";
}

/**
 * why: Discovery runs once, at daemon start, so a refusal is a frozen snapshot: repairing the
 * root and running `doctor` again reports the identical finding, because nothing has
 * looked at the root since. The finding therefore has to name the step that actually
 * retries the platform, or it reads as a repair that did not work.
 */
const DRIVER_RETRY_REMEDY =
  "Driver discovery runs once, at daemon startup: restart the daemon (`simlock daemon stop`, then any command relaunches it) once this is fixed, or the platform stays unavailable.";

function driverUnavailableFindings(rejections: readonly DriverRejection[]): DoctorFinding[] {
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
function unreachableTarget(
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

function overLimit(input: {
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

function isDrift(finding: DoctorFinding): boolean {
  return (
    finding.kind !== "driver-advisory" &&
    finding.kind !== "prerequisite-missing" &&
    finding.kind !== "service-broken" &&
    finding.kind !== "warm-pool-target-unreachable" &&
    finding.kind !== "module-unavailable"
  );
}

function prerequisiteFindings(
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

function orphanFindings(
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

function expiredLeaseFindings(
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

function expectedRunState(state: DeviceState): "running" | "stopped" | undefined {
  switch (state) {
    case "ready":
    case "leased":
      return "running";
    case "shutdown":
      return "stopped";
    case "provisioning":
    case "reclaiming":
    case "quarantined":
    case "absent":
    case "deleted":
      return undefined;
  }
}

function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
