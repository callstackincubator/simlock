import type { EventBus } from "../bus/index.js";
import { type Clock, type Logger, NoopLogger } from "../ports/index.js";
import type { Config } from "./config.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  type DeviceState,
  type Platform,
  transitionEnteredAt,
} from "./domain.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type {
  Driver,
  DriverDevice,
  DriverRejection,
  DriverRejectionReason,
  ObservedDevice,
  ObservedMark,
} from "./driver.js";
import type { LeaseExpirer } from "./lease-ports.js";
import type { Registry } from "./registry.js";

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
      /** A platform Simlock is running without, because its driver refused to start. */
      readonly kind: "driver-unavailable";
      readonly platform: Platform;
      readonly reason: DriverRejectionReason;
      readonly detail: string;
    }
  | {
      /**
       * A registry device that outlived the move to owned roots: absent from this
       * driver's root, still present in the location the platform used before it.
       */
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
    };

/**
 * `erased` -- the durable mark stands but the erasable one is gone: the device
 * was erased or wiped outside Simlock.
 * `mark-mismatch` -- both regions carry a token but they disagree, so
 * something re-marked one region independently.
 * `durable-mark-missing` -- the durable region carries no token at all: the
 * device definition was recreated, or foreign tooling rewrote it. On Android
 * that also catches an `avdmanager create` reusing a `simlock_` name, which
 * the prefix match in `listManaged` would otherwise adopt silently.
 */
export type ProvenanceDrift = "erased" | "mark-mismatch" | "durable-mark-missing";

type OrphanDeviceFinding = Extract<DoctorFinding, { readonly kind: "orphan-device" }>;

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
}

/** The one quarantine-entry operation Doctor needs -- see `QuarantineCoordinator.enterFromStalledTransition`. */
export interface DoctorQuarantine {
  enterFromStalledTransition(deviceId: string): Promise<void>;
}

export interface DoctorOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly leaseExpirer?: LeaseExpirer;
  readonly quarantine?: DoctorQuarantine;
  /**
   * Read-only view of the per-device operation claims. A device this daemon holds a
   * claim on is work in progress by definition, which is what keeps a healthy
   * backgrounded reclaim from being read as a stall -- see `stalledTransitionFinding`.
   */
  readonly claims?: Pick<DeviceOperationClaims, "isClaimed">;
  /**
   * Drivers that refused to start, as reported once at daemon startup. They are findings
   * on every run, not just the first: the daemon has been serving without that platform
   * ever since, and `doctor` is where `docs/CLI.md` promises the reason turns up.
   */
  readonly driverRejections?: readonly DriverRejection[];
  readonly logger?: Logger;
  readonly registry: Registry;
}

export interface DoctorReconcileOptions {
  readonly fix?: boolean;
  /**
   * Destroys the orphans this run finds. Safety rule 1's single opt-in exception, and
   * deliberately not part of `fix`: someone already running `doctor --fix` unattended in
   * CI must not acquire a destructive behaviour by upgrading (ADR 0001, decision 6).
   */
  readonly purgeOrphans?: boolean;
}

export class Doctor {
  readonly #logger: Logger;

  constructor(private readonly options: DoctorOptions) {
    this.#logger = options.logger?.child("doctor") ?? new NoopLogger();
  }

  async reconcile({
    fix = false,
    purgeOrphans = false,
  }: DoctorReconcileOptions = {}): Promise<DoctorReport> {
    const snapshot = this.options.registry.snapshot;
    const realities = await Promise.all(
      this.options.drivers.map(async (driver) => ({ driver, reality: await driver.listManaged() })),
    );
    // A platform with no driver has no observable reality: its driver refused to start,
    // its SDK is missing, or this host has none. "I could not look" is not "the device is
    // gone", and reading it as such is destructive -- every registry device of that
    // platform would drift-report as missing and `--fix` would mark the lot `deleted`,
    // stranding tens of gigabytes of simulators in a root with no record left to reach
    // them. That is the permanent leak ADR 0001 exists to prevent, so existence, run
    // state, provenance and orphans are all reported only for platforms a driver
    // actually observed. What remains reportable is what needs no driver: expired
    // leases, and the `driver-unavailable` finding that says why the platform is dark.
    const observedPlatforms = new Set(this.options.drivers.map((driver) => driver.platform));
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

    for (const device of snapshot.devices) {
      if (observedPlatforms.has(device.spec.platform)) {
        const deviceFindings = await this.#withLegacyDevice(
          device,
          registryDriftFindings(device, realDeviceKeys, observedDevices),
          driversByPlatform.get(device.spec.platform),
        );
        findings.push(...deviceFindings);
        if (deviceFindings.some((finding) => finding.kind === "foreign-state-change")) {
          await this.options.registry.markForeignStateDetected(device.id, this.options.clock.now());
        }
        if (deviceFindings.some((finding) => finding.kind === "foreign-provenance-change")) {
          await this.options.registry.markForeignProvenanceDetected(
            device.id,
            this.options.clock.now(),
          );
        }
      }
      const stalled = stalledTransitionFinding(
        device,
        driversByPlatform,
        this.options.config.stalledTransition,
        this.options.clock.now(),
        this.options.claims,
      );
      if (stalled !== undefined) {
        findings.push(stalled);
      }
    }
    findings.push(...driverUnavailableFindings(this.options.driverRejections ?? []));
    findings.push(...orphanFindings(realities, registryDeviceKeys));
    findings.push(...expiredLeaseFindings(snapshot.leases, this.options.clock.now()));

    if (fix) {
      await this.#applySafeFixes(findings, driversByPlatform);
    }
    const remaining = purgeOrphans
      ? await this.#purgeOrphans(findings, driversByPlatform)
      : findings;

    const report = { findings: remaining };
    this.#emitFindingEvents(remaining);
    this.options.eventBus.emit("doctor.reconciled", { driftFindings: remaining }, "doctor");
    return report;
  }

  /**
   * Destroys every orphan this run found, and reports back the findings that outlived the
   * attempt.
   *
   * This is the one place Simlock destroys something the registry has never heard of, and
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
        await driver.destroy(orphan.device);
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

    // An `orphan-process` for a device that is now gone is gone with it: destroying the
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
   * Re-proves each root the purge is about to reach into, before its first destroy.
   *
   * The proof a purge acts on is the one taken at startup, and the thing it authorises is
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
   * Rewrites a `registry-device-missing` finding as `legacy-device` when the driver still
   * finds the device where the platform kept it before roots existed. Absent from the root
   * is what both findings have in common; where the device actually is decides which one it
   * is, and only the driver can look there.
   *
   * A driver that cannot answer -- no legacy location, or a lookup that failed -- leaves
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
      if (finding.kind === "stalled-transition") {
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
  }

  // fallow-ignore-next-line complexity -- one exhaustive arm per finding kind, each a single call or a documented no-op.
  async #applySafeFixes(
    findings: readonly DoctorFinding[],
    driversByPlatform: ReadonlyMap<Platform, Driver>,
  ): Promise<void> {
    for (const finding of findings) {
      switch (finding.kind) {
        case "registry-device-missing":
          await this.#fixMissingDevice(finding.deviceId);
          break;
        case "orphan-device":
        case "orphan-process":
          // Registry-only destruction: unregistered reality is report-only.
          break;
        case "expired-live-lease":
          if (this.options.leaseExpirer !== undefined) {
            await this.options.leaseExpirer.expire(finding.leaseId);
          }
          break;
        case "foreign-state-change":
          await this.#fixForeignStateChange(finding);
          break;
        case "foreign-provenance-change":
          // Report-only: re-marking destroys the evidence, and the device may be leased.
          break;
        case "driver-unavailable":
          // Nothing here can repair a refused root or an occupied port without doing the
          // one thing failing closed exists to prevent: adopting what it refused.
          break;
        case "legacy-device":
          await this.#fixLegacyDevice(finding, driversByPlatform.get(finding.platform));
          break;
        case "stalled-transition":
          await this.#fixStalledTransition(finding);
          break;
      }
    }
  }

  async #fixMissingDevice(deviceId: string): Promise<void> {
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === deviceId);
    if (device !== undefined && device.state !== "deleted") {
      await this.options.registry.markDeviceMissing(deviceId, "doctor");
    }
  }

  /**
   * Destroys a stranded pre-root device and then records what that leaves behind.
   *
   * The destroy reaches outside the driver's root, which every other path in Simlock is
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
      await destroyLegacy(finding.device);
    } catch (error: unknown) {
      this.#logger.error("Could not destroy a pre-root device", {
        deviceId: finding.deviceId,
        platform: finding.platform,
        reason: errorMessage(error),
      });
      return;
    }
    await this.#fixMissingDevice(finding.deviceId);
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
    // Only `ready` and `shutdown` have a legal transition to the opposite run state. A
    // device recorded as `leased` with no lease record reaches here past the lease guard
    // above; correcting it would throw IllegalTransition and abort the whole reconcile,
    // so leave it to the report rather than crashing the reaper tick.
    if (device.state === "ready" && finding.observed === "stopped") {
      await this.options.registry.transitionDevice(finding.deviceId, "shutdown", {
        event: "device.shutdown",
        payload: { deviceId: finding.deviceId, initiator: "doctor" },
      });
    } else if (device.state === "shutdown" && finding.observed === "running") {
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
    // A device this finding targets is never `leased` -- that's a separate state
    // entirely -- but the guard is kept anyway, matching every other fix here, so a
    // future change to what produces this finding can never reach a leased device.
    const snapshot = this.options.registry.snapshot;
    if (snapshot.leases.some((lease) => lease.deviceId === finding.deviceId)) {
      return;
    }
    const device = snapshot.devices.find((candidate) => candidate.id === finding.deviceId);
    // Only fix if the device is still in the exact state the finding was computed
    // against -- it may have resolved on its own between finding computation and fix
    // application within this reconcile call.
    if (device === undefined || device.state !== finding.state) {
      return;
    }
    if (this.options.quarantine === undefined) {
      return;
    }
    await this.options.quarantine.enterFromStalledTransition(finding.deviceId);
  }
}

/** Existence and boot-state drift for a single registry device against observed reality. */
function registryDriftFindings(
  device: DeviceRecord,
  realDeviceKeys: ReadonlySet<string>,
  observedDevices: ReadonlyMap<string, ObservedDevice>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const deviceKey = key(device.spec.platform, device.driverDeviceId);

  if (device.state !== "deleted" && !realDeviceKeys.has(deviceKey)) {
    findings.push({
      deviceId: device.id,
      kind: "registry-device-missing",
      platform: device.spec.platform,
    });
  }

  // `expected === undefined` means the registry is mid-transition (provisioning,
  // reclaiming, deleted). Simlock is acting on the device itself in those states,
  // including erasing it, so neither run state nor marks are compared.
  const expected = expectedRunState(device.state);
  const observed = observedDevices.get(deviceKey);
  if (expected === undefined || observed === undefined) {
    return findings;
  }

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
 * The reclaim estimate for the slowest strategy the driver would pick, whatever the clean
 * level. A `reclaiming` record does not say which level started it -- every production path
 * asks for `standard`, but that is the caller's choice, not an invariant this finding can
 * depend on -- and the two errors are not symmetric: an estimate that is too tight turns a
 * healthy reclaim into a false stall finding, while one that is too loose only delays a real
 * one. So this takes the slower branch rather than assuming.
 */
function slowestReclaimEstimateMs(driver: Driver, spec: DeviceSpec): number {
  return Math.max(
    driver.estimate({ clean: "standard", operation: "reclaim" }, spec),
    driver.estimate({ clean: "full", operation: "reclaim" }, spec),
  );
}

/**
 * A `provisioning` / `reclaiming` device is normally in-flight work Simlock itself is
 * driving (see `expectedRunState`), not drift -- but only up to a point. Past a
 * driver-derived threshold it stops being "still working" and becomes a stall: the
 * driver call that was supposed to resolve it never did. This is a documented failure
 * mode, not a hypothetical one -- `DeviceProvisioner` deliberately leaves a device
 * `provisioning` when a boot-timeout's own cleanup `destroy` also fails ("The
 * registered record remains for reconcile when the driver cannot destroy it").
 *
 * The threshold is `driver.estimate(...) * thresholdMultiplier`, floored at
 * `minimumThresholdMs`: not `estimate` itself, because the estimate is tuned for a
 * routine run and real-world variance (a cold Android boot, a loaded host) can
 * legitimately run well past it without anything having stalled. No driver for the
 * device's platform, or no recorded entry time (defensive; see `transitionEnteredAt`),
 * means there is nothing to compare against, so no finding rather than a guess.
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
 * orphaned by a crash has no claim in the new process, so the case this finding exists to
 * catch is untouched.
 */
function stalledTransitionFinding(
  device: DeviceRecord,
  driversByPlatform: ReadonlyMap<Platform, Driver>,
  config: Config["stalledTransition"],
  now: number,
  claims?: Pick<DeviceOperationClaims, "isClaimed">,
): DoctorFinding | undefined {
  if (device.state !== "provisioning" && device.state !== "reclaiming") {
    return undefined;
  }
  if (claims?.isClaimed(device.id) === true) {
    return undefined;
  }
  const enteredAt = transitionEnteredAt(device);
  const driver = driversByPlatform.get(device.spec.platform);
  if (enteredAt === undefined || driver === undefined) {
    return undefined;
  }

  const estimateMs =
    device.state === "provisioning"
      ? driver.estimate({ operation: "provision" }, device.spec) +
        driver.estimate({ operation: "boot" }, device.spec)
      : slowestReclaimEstimateMs(driver, device.spec);
  const thresholdMs = Math.max(estimateMs * config.thresholdMultiplier, config.minimumThresholdMs);
  const ageMs = now - enteredAt;
  if (ageMs <= thresholdMs) {
    return undefined;
  }

  return {
    ageMs,
    deviceId: device.id,
    enteredAt,
    kind: "stalled-transition",
    platform: device.spec.platform,
    state: device.state,
    thresholdMs,
  };
}

/**
 * Report-only by design. Re-marking would overwrite the only evidence that the
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
 * Discovery runs once, at daemon start, so a refusal is a frozen snapshot: repairing the
 * root and running `doctor` again reports the identical finding, because nothing has
 * looked at the root since. The finding therefore has to name the step that actually
 * retries the platform, or it reads as a repair that did not work.
 */
const DRIVER_RETRY_REMEDY =
  "Driver discovery runs once, at daemon startup: restart the daemon (`simlock daemon stop`, then any command relaunches it) once this is fixed, or the platform stays unavailable.";

function driverUnavailableFindings(rejections: readonly DriverRejection[]): DoctorFinding[] {
  return rejections.map((rejection) => ({
    detail: `${rejection.summary}. ${DRIVER_RETRY_REMEDY}`,
    kind: "driver-unavailable" as const,
    platform: rejection.platform,
    reason: rejection.reason,
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
