import { type Logger, NoopLogger } from "../ports/index.js";
import { mayBeGranted, type DeviceRecord, type Platform, type VirtualDevice } from "./domain.js";
import {
  type Driver,
  type DriverCatalogEntry,
  type DriverReality,
  type DriverSource,
  type MissingPrerequisite,
  type ObservedDevice,
  virtualDriverDevice,
} from "./driver.js";
import {
  type DoctorFinding,
  type DoctorOptions,
  type DoctorReconcileOptions,
  type DoctorReport,
  type DoctorSource,
  errorMessage,
  key,
  type OptionalModuleFinding,
  type OrphanDeviceFinding,
} from "./doctor-types.js";
import { isDrift, registryDriftFindings } from "./doctor-drift.js";
import {
  driverUnavailableFindings,
  expiredLeaseFindings,
  orphanFindings,
  overLimit,
  prerequisiteFindings,
  stalledTransitionFinding,
  unreachableTarget,
} from "./doctor-findings.js";
import {
  reservedRunning,
  reserveOnVirtualPlatforms,
  type WarmTargetFigures,
} from "./warm-pool/index.js";
import type { StartupRead } from "./startup-read.js";

export type {
  DoctorConfig,
  DoctorFinding,
  DoctorOptions,
  DoctorReconcileOptions,
  DoctorReport,
  OptionalModuleFinding,
  ServiceCheck,
} from "./doctor-types.js";
export { isStalledTransition } from "./doctor-findings.js";
export type { StallInput } from "./doctor-findings.js";

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

    const report = { findings: remaining, sources: await this.#sources(purgeOrphans) };
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

  /** why: a platform whose source read fails lists none; one failure must not hide the rest of the report. */
  async #sources(purgeOrphans: boolean): Promise<readonly DoctorSource[]> {
    await this.#checkBaselines();
    const lists = await Promise.all(
      this.options.drivers.map(async (driver) => {
        try {
          const listed = this.#named(await driver.listSources());
          const kept: DriverSource[] = [];
          for (const source of listed) {
            if (
              purgeOrphans &&
              source.orphan === true &&
              (await this.#purgeSource(driver, source))
            ) {
              continue;
            }
            kept.push(source);
          }
          return kept.map(({ id: _id, ...source }): DoctorSource => ({
            ...source,
            platform: driver.platform,
          }));
        } catch (error: unknown) {
          this.#logger.warn(
            `could not list ${driver.platform} sources: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /** why: a stale check that fails must not hide the rest of the report. */
  async #checkBaselines(): Promise<void> {
    try {
      await this.options.baselines?.checkStale();
    } catch (error: unknown) {
      this.#logger.warn(
        `could not check baselines for staleness: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #named(sources: readonly DriverSource[]): readonly DriverSource[] {
    return this.options.baselines?.nameSources(sources) ?? sources;
  }

  async #purgeSource(driver: Driver, source: DriverSource): Promise<boolean> {
    try {
      await driver.destroySource(source.id);
      return true;
    } catch (error: unknown) {
      this.#logger.error("Could not purge orphan source", {
        platform: driver.platform,
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
      unreachableTarget(
        target,
        catalogs.get(target.platform),
        this.options.config[target.platform].virtualDevices,
      ),
    );
    const { android, ios } = this.options.config;
    const reserves = reservedRunning(
      {
        reserveRunning: reserveOnVirtualPlatforms(
          this.options.config.warmPool.reserveRunning,
          (platform) => (platform === "ios" ? ios : android).virtualDevices,
        ),
      },
      limits,
    );
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
