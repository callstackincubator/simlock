import type { EventBus } from "../../bus/index.js";
import type { StateDatabase } from "../../state/index.js";
import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../../ports/index.js";
import {
  capacityDevice,
  capacityDevices,
  type CapacityCoordinator,
  plannedCapacityDevice,
} from "../capacity/index.js";
import type { DeviceOperationClaims } from "../device-operation-claims.js";
import type { DeviceProvisioner } from "../device-provisioner.js";
import {
  type DeviceMode,
  type VirtualDevice,
  type VirtualSpec,
  type LeaseRecord,
  type Platform,
  sameSpec,
  type TargetResolution,
  type WaitingDemand,
} from "../domain.js";
import type { DeviceRequest } from "../driver.js";
import type { DriverCatalog } from "../driver-catalog.js";
import type { ManagedDeviceLifecycle } from "../managed-device-lifecycle.js";
import type { SerializedDecision } from "../serialized-decision.js";
import { stableError } from "../stable-error.js";
import type { WarmPoolConfig, WarmTarget } from "./config.js";
import {
  describeTarget,
  evaluate,
  type ResolvedTarget,
  readyCount,
  targetedDevices,
  type TargetKind,
  type TargetReport,
  type WarmProposal,
} from "./policy.js";
import type { WarmPoolFigures, WarmTargetFigures } from "./figures.js";
import { CatalogCheck } from "./catalog-check.js";
import { type LearnedKind, LearnedKinds } from "./learned.js";
import { RetrySchedule } from "./retry.js";

export interface WarmPoolOptions {
  readonly acquisition: {
    kick(): void;
    /** An operator reset (`nuke`) holds acquisition closed: the pool leaves every device alone. */
    readonly maintenanceActive: boolean;
    waitingDemand(): readonly WaitingDemand[];
    /**
     * Resolves a request the way a lease request is resolved, with downloads off, and answers
     * the spec or why there is none. A target is such a request (ADR 0007 §2, ADR 0015 §5).
     */
    resolve(request: DeviceRequest): Promise<TargetResolution>;
    /** The mode a request naming none plans on a platform: where a target with no mode lands. */
    defaultMode(platform: Platform): DeviceMode;
  };
  readonly capacity: Pick<
    CapacityCoordinator,
    "canBoot" | "canProvision" | "runningCapacity" | "tryReserveBoot" | "tryReserveProvisioning"
  >;
  readonly claims: Pick<DeviceOperationClaims, "claim" | "isClaimed" | "operationFor" | "tryClaim">;
  readonly clock: Clock;
  readonly config: WarmPoolConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "emit" | "subscribe">;
  readonly hasDriver: (platform: Platform) => boolean;
  readonly idle: { readonly shutdownAfterMs: number };
  /** why: the pool reads the catalog of a platform with a learned kind, to forget a kind whose model or runtime is gone. */
  readonly catalog: Pick<DriverCatalog, "listCatalog">;
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "bootWarm" | "shutdown">;
  readonly logger?: Logger;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly state: StateDatabase;
  readonly registry: {
    readonly snapshot: {
      readonly virtualDevices: readonly VirtualDevice[];
      readonly leases: readonly LeaseRecord[];
    };
  };
}

/** why: how many failed boots or creations in a row make the pool give a learned kind up. */
const LEARNED_FAILURES_LIMIT = 3;

/** The tick that re-runs a pass when no event does, so a slot freed silently is still used. */
export const WARM_POOL_TICK_MS = 30_000;

/** why: a boot or creation of the pool that runs beside the pass, for a target or a waiter: its spec, and its end. */
interface Flight {
  readonly creation: boolean;
  readonly spec: VirtualSpec;
  done: Promise<void>;
}

/**
 * why: observes the bus and runs one pass at a time over the pool: it resolves the operator's targets,
 * reads a snapshot, asks the policy what to shut down, boot and create, and does each through the
 * device lifecycle and the provisioner, revalidating the device first (safety rule 2). A trigger
 * that arrives during a pass asks for one more, not one each.
 *
 * Every action that is attempted ends in `kick()`, whether it worked or not, so a request waiting
 * on a boot the pool started plans again either way; one declined before it began does not. A
 * boot or creation for a target or for a waiting request runs beside the pass, up to
 * `maxConcurrentBoots` at a time with the waiting requests' own, and asks for the next pass when
 * it ends.
 */
export class WarmPool {
  readonly #logger: Logger;
  readonly #unsubscribe: (() => void)[] = [];
  /** why: when a device whose shutdown failed may be tried again, by device id. */
  readonly #retryAfter = new Map<string, number>();
  /** When a target's spec whose boot or creation failed may be tried again. */
  readonly #schedule = new RetrySchedule();
  readonly #flights = new Set<Flight>();
  readonly #learned: LearnedKinds;
  readonly #catalogCheck: CatalogCheck;
  /** why: whether the rows left open by a daemon that stopped have been closed against the registry. */
  #openClosed = false;
  /** why: whether this pass has already logged that the record could not be read. */
  #readLogged = false;
  #again = false;
  #disposed = false;
  /** A graceful stop is draining: what is in flight finishes, and nothing new starts. */
  #draining = false;
  #started = false;
  /** Devices shut down under an operator reset that have not left `shutdown` since. */
  readonly #reset = new Set<string>();
  /** The targets the last pass planned for: their counts and specs, which `targeted()` also reads. */
  #resolved: readonly ResolvedTarget[] = [];
  /** Targets refused as `unresolvable` that keep their last spec: spared, never planned for. */
  #spared: readonly ResolvedTarget[] = [];
  #hasResolved = false;
  /** The spec each target last resolved to, which a transient refusal does not take away. */
  readonly #lastSpecs = new Map<string, VirtualSpec>();
  /** Every target's state as the last pass left it. */
  #reports: readonly TargetReport[] = [];
  /** why: every report of the last pass, learned kinds included, which `figures()` lists and the log and the event leave out. */
  #figured: readonly TargetReport[] = [];
  /** Whether a pass has left its reports yet: until one has, the figures come from the config. */
  #passed = false;
  /**
   * The configured targets (by position in `warmPool.targets`) that missed their count and have
   * not been met since: the event fires on entering this, and a target leaves it only when its
   * ready devices reach its count.
   */
  #missed = new Set<number>();
  /** Which configured targets each report stands for: a report merges those of one spec. */
  #covers = new WeakMap<TargetReport, readonly number[]>();
  /** The spec each resolved target resolved to this pass, by position in `warmPool.targets`. */
  #owners: readonly { readonly index: number; readonly spec: VirtualSpec }[] = [];
  #loggedShort = new Set<string>();
  #retryTimer: TimerHandle | undefined;
  #running: Promise<void> | undefined;
  #tick: TimerHandle | undefined;

  constructor(private readonly options: WarmPoolOptions) {
    this.#logger = options.logger?.child("warm-pool") ?? new NoopLogger();
    this.#learned = new LearnedKinds(options.state);
    this.#catalogCheck = new CatalogCheck({
      catalog: options.catalog,
      clock: options.clock,
      hasDriver: options.hasDriver,
      logger: this.#logger,
      onAnswer: () => this.#trigger(),
    });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const event of TRIGGERS) {
      this.#unsubscribe.push(this.options.eventBus.subscribe(event, () => this.#trigger()));
    }
    this.#subscribeLearning();
    this.#closeOpenRows();
    this.#armTick();
  }

  /** why: forgets every learned kind, as nuke starts the pool over; the next lease learns its kind again. */
  forget(): void {
    this.#learned.clear();
  }

  /** why: the pool learns from committed facts on the bus, never from the lease path (ADR 0017 §3). */
  #subscribeLearning(): void {
    const { clock, eventBus, registry } = this.options;
    this.#unsubscribe.push(
      eventBus.subscribe("lease.granted", ({ payload }) => {
        if (!this.options.config.enabled) return;
        const device = registry.snapshot.virtualDevices.find(
          (candidate) => candidate.id === payload.deviceId,
        );
        if (device === undefined) return;
        this.#recording("learn a lease", () =>
          this.#learned.learn(device.spec, payload.leaseId, clock.now()),
        );
      }),
    );
    for (const event of ["lease.released", "lease.expired"] as const) {
      this.#unsubscribe.push(
        eventBus.subscribe(event, ({ payload }) =>
          this.#recording("close a lease", () => this.#learned.ended(payload.leaseId, clock.now())),
        ),
      );
    }
  }

  /** why: a failing record costs the pool what it learns, never a lease or a pass: the error is logged and the work goes on. */
  #recording(step: string, work: () => void): void {
    try {
      work();
    } catch (error: unknown) {
      this.#logger.warn(`the warm pool's record could not ${step}`, { error: stableError(error) });
    }
  }

  /** why: closes the lease rows no lease holds, once; a failure leaves them for the next pass to try again. */
  #closeOpenRows(): void {
    if (this.#openClosed || !this.#started) return;
    const held = new Set(this.options.registry.snapshot.leases.map((lease) => lease.id));
    this.#recording("close its open lease rows", () => {
      this.#learned.closeOpen(held, this.options.clock.now());
      this.#openClosed = true;
    });
  }

  /** why: the learned kinds, or none when the record cannot be read; the failure is logged once per pass. */
  #learnedKinds(): LearnedKind[] {
    try {
      return this.#learned.kinds(this.options.clock.now());
    } catch (error: unknown) {
      if (!this.#readLogged) {
        this.#logger.warn("the warm pool's record could not be read", {
          error: stableError(error),
        });
      }
      this.#readLogged = true;
      return [];
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#tick !== undefined) this.options.clock.cancel(this.#tick);
    this.#tick = undefined;
    if (this.#retryTimer !== undefined) this.options.clock.cancel(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  /** Runs a pass, or joins the one running and asks for one more. Resolves when they are done. */
  pass(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    const running = this.#drain().finally(() => {
      this.#running = undefined;
    });
    this.#running = running;
    return running;
  }

  /** Resolves once no pass is running or waiting, and no target boot or creation is running. */
  async settle(): Promise<void> {
    while (this.#running !== undefined || this.#flights.size > 0) {
      await this.#running;
      await Promise.all([...this.#flights].map((flight) => flight.done));
    }
  }

  /**
   * A graceful stop: starts nothing new, then waits for the pass and the boots and creations
   * already running (architecture rule 12). Without it each flight that ends would ask for the
   * next pass, and a stop would create every missing target device before it exited.
   */
  async drain(): Promise<void> {
    this.close();
    await this.settle();
  }

  /**
   * Closes the pool to new work, ahead of `drain`: a graceful stop closes it before anything it
   * waits for can ask for a pass.
   */
  close(): void {
    this.#draining = true;
  }

  /** why: resolve before the first reaper run, and read live demand so cancellation drops queue protection. */
  async targeted(): Promise<ReadonlySet<string>> {
    if (!this.options.config.enabled) return new Set();
    if (!this.#hasResolved) await this.#resolveTargets();
    const { leases, virtualDevices: devices } = this.options.registry.snapshot;
    return targetedDevices({
      devices,
      isClaimed: (deviceId) => this.options.claims.isClaimed(deviceId),
      leases,
      learned: this.#learnedKinds(),
      targets: [...this.#resolved, ...this.#spared],
      waiting: this.options.acquisition.waitingDemand(),
    });
  }

  /** why: every configured target's report as the last pass left it: how many are ready, and why not more. Targets that resolved to one spec are one report. */
  targets(): readonly TargetReport[] {
    return this.#reports;
  }

  /**
   * What `status`, `doctor` and the console read: the pool as the last pass left it. With the
   * pool off, or before a pass has run, every configured target as the operator wrote it: short
   * `disabled` with the pool off, and with no reason before the first pass.
   */
  figures(): WarmPoolFigures {
    const { enabled, reserveRunning, targets } = this.options.config;
    const reports =
      enabled && this.#passed
        ? this.#figured
        : targets.map((target): TargetReport => {
            const kind = this.#kindOfTarget(target);
            return {
              booting: 0,
              configuredCount: target.count,
              count: target.count,
              kind,
              origin: "configured",
              ready: 0,
              target: describeTarget(target),
              ...(enabled ? {} : { short: "disabled" as const }),
            };
          });
    return {
      enabled,
      reserveRunning: { android: reserveRunning.android, ios: reserveRunning.ios },
      targets: reports.map(figureOf),
    };
  }

  #trigger(): void {
    if (this.#disposed || this.#draining) return;
    void this.pass();
  }

  #armTick(): void {
    this.#tick = this.options.clock.setTimer(WARM_POOL_TICK_MS, () => {
      this.#trigger();
      this.#armTick();
    });
  }

  /** One timer, for the earliest moment a target held back by a failure may be tried again. */
  #armRetry(): void {
    if (this.#retryTimer !== undefined) this.options.clock.cancel(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#disposed || this.#draining) return;
    const now = this.options.clock.now();
    const at = this.#schedule.nextAttemptAt(now);
    if (at === undefined) return;
    this.#retryTimer = this.options.clock.setTimer(at - now, () => {
      this.#retryTimer = undefined;
      this.#trigger();
    });
  }

  async #drain(): Promise<void> {
    do {
      this.#again = false;
      await this.#once();
    } while (this.#again);
  }

  /** why: whatever is shut down under a reset, an iOS device its forced release left that way included, is meant to stay down. */
  #markReset(): void {
    for (const device of this.options.registry.snapshot.virtualDevices) {
      if (device.state === "shutdown") this.#reset.add(device.id);
    }
  }

  /** why: a pool that is off keeps no target: nothing is resolved, reported, checked or spared. */
  async #resolveEnabled(): Promise<readonly TargetReport[]> {
    if (!this.options.config.enabled) return [];
    const refused = await this.#resolveTargets();
    this.#checkCatalog();
    return refused;
  }

  async #once(): Promise<void> {
    if (this.#draining) return;
    if (this.options.acquisition.maintenanceActive) {
      this.#markReset();
      return;
    }
    this.#readLogged = false;
    this.#closeOpenRows();
    try {
      const refused = await this.#resolveEnabled();
      const plan = await this.options.decisions.run(() => evaluate(this.#view()));
      const everyReport = [...refused, ...plan.targets];
      const reports = configuredOnly(everyReport);
      this.#figured = everyReport;
      this.#note(reports);
      for (const proposal of plan.proposals) {
        if (this.#draining) break;
        await this.#act(proposal);
      }
      this.#announceMissed(reports);
      this.#armRetry();
    } catch (error: unknown) {
      this.#logger.error("a warm pool pass failed", { step: "pass", error: stableError(error) });
    }
  }

  /** why: forgets the kinds the last catalog answers no longer list, then starts the next reads without waiting for them. */
  #checkCatalog(): void {
    const kinds = this.#learnedKinds();
    for (const kind of this.#catalogCheck.gone(kinds)) {
      this.#recording("forget a kind", () => this.#learned.forget(kind.spec));
      this.#logger.info("a warm pool learned kind was forgotten: its model or runtime is gone", {
        model: kind.spec.model,
        osVersion: kind.spec.osVersion,
        platform: kind.spec.platform,
      });
    }
    this.#catalogCheck.start(new Set(kinds.map((kind) => kind.spec.platform)));
  }

  /**
   * Resolves every target the way a request is resolved. Per pass, so a runtime installed since
   * the last one takes effect without a restart. Returns the reports of the targets that were
   * refused, one that failed to resolve for no settled reason included; the policy merges the
   * ones that resolved.
   */
  async #resolveTargets(): Promise<readonly TargetReport[]> {
    const answers = await Promise.all(
      this.options.config.targets.map(async (target, index) => ({
        index,
        resolution: await this.options.acquisition.resolve(requestFor(target)),
        target,
      })),
    );
    const resolved: ResolvedTarget[] = [];
    const spared: ResolvedTarget[] = [];
    const refused: TargetReport[] = [];
    const owners: { index: number; spec: VirtualSpec }[] = [];
    for (const { index, resolution, target } of answers) {
      const key = JSON.stringify(target);
      if ("spec" in resolution) {
        this.#lastSpecs.set(key, resolution.spec);
        owners.push({ index, spec: resolution.spec });
        resolved.push({ count: target.count, spec: resolution.spec });
        continue;
      }
      // A refusal that is no settled fact (no driver, no such runtime or model) may be a read that
      // failed once: the target keeps the spec it last resolved to only to spare its devices, which
      // the pass does not treat as unwanted. It is reported short all the same, and gets no boot or
      // creation from a spec that may be stale.
      const last = resolution.refusal === "unresolvable" ? this.#lastSpecs.get(key) : undefined;
      if (last === undefined) this.#lastSpecs.delete(key);
      else spared.push({ count: target.count, spec: last });
      const report: TargetReport = {
        // What of the spec it last resolved to is still being booted or created.
        booting:
          last === undefined
            ? 0
            : [...this.#flights].filter((flight) => sameSpec(flight.spec, last)).length,
        configuredCount: target.count,
        count: target.count,
        kind: this.#kindOfTarget(target),
        message: resolution.message,
        origin: "configured",
        ready: last === undefined ? 0 : readyCount(this.#deviceCounts(), last),
        short: resolution.refusal,
        target: describeTarget(target),
      };
      this.#covers.set(report, [index]);
      refused.push(report);
    }
    this.#owners = owners;
    this.#resolved = resolved;
    this.#spared = spared;
    this.#hasResolved = true;
    return refused;
  }

  #deviceCounts(): Parameters<typeof readyCount>[0] {
    const { leases, virtualDevices: devices } = this.options.registry.snapshot;
    return { devices, isClaimed: (deviceId) => this.options.claims.isClaimed(deviceId), leases };
  }

  /** Keeps the reports, and logs a target the first pass it is short for a reason. */
  #note(reports: readonly TargetReport[]): void {
    this.#reports = reports;
    this.#passed = true;
    const shorts = new Set<string>();
    for (const report of reports) {
      if (report.short === undefined) continue;
      const key = `${report.target}|${report.short}`;
      shorts.add(key);
      if (this.#loggedShort.has(key)) continue;
      this.#logger.warn("a warm pool target is short", {
        count: report.count,
        ready: report.ready,
        short: report.short,
        target: report.target,
        message: report.message,
      });
    }
    this.#loggedShort = shorts;
  }

  /**
   * Emits `warm-pool.target-missed` for a target that is short after this pass and has not missed
   * since it was last met: the edge, not each short pass (ADR 0017 §7). A target that is filling,
   * or short again after a retry, is still the same miss; only ready devices reaching its count
   * end it. Once the pass's actions have run, so a subscriber never reads a pool the pass has not
   * yet acted on.
   */
  #announceMissed(reports: readonly TargetReport[]): void {
    for (const report of reports) {
      const covered = this.#coveredBy(report);
      if (report.ready >= report.count) {
        for (const index of covered) this.#missed.delete(index);
        continue;
      }
      if (report.short === undefined) continue;
      const fresh = covered.filter((index) => !this.#missed.has(index));
      for (const index of covered) this.#missed.add(index);
      if (fresh.length === 0) continue;
      this.options.eventBus.emit(
        "warm-pool.target-missed",
        {
          count: report.count,
          mode: report.kind.mode,
          model: report.kind.model,
          origin: "configured",
          platform: report.kind.platform,
          ready: report.ready,
          reason: report.short,
          ...(report.kind.osVersion === undefined ? {} : { osVersion: report.kind.osVersion }),
        },
        "warm-pool",
      );
    }
  }

  /** The configured targets a report stands for: its own, or those that resolved to its spec. */
  #coveredBy(report: TargetReport): readonly number[] {
    const own = this.#covers.get(report);
    if (own !== undefined) return own;
    return this.#owners
      .filter((owner) => report.spec !== undefined && sameSpec(owner.spec, report.spec))
      .map((owner) => owner.index);
  }

  /** A configured target's kind as a report names it: the mode it names, else the platform's. */
  #kindOfTarget(target: WarmTarget): TargetKind {
    return {
      mode: target.mode ?? this.options.acquisition.defaultMode(target.platform),
      model: target.model,
      platform: target.platform,
      ...(target.osVersion === undefined ? {} : { osVersion: target.osVersion }),
    };
  }

  #view(): Parameters<typeof evaluate>[0] {
    const { leases, virtualDevices: all } = this.options.registry.snapshot;
    for (const id of this.#reset) {
      if (all.find((device) => device.id === id)?.state !== "shutdown") this.#reset.delete(id);
    }
    // why: a platform discovery refused has no driver, so acting on its devices only fails and
    // spends the pass's victim; startup skips them the same way. The capacity totals below stay
    // unfiltered: the device holds its slot, or the pool would see a free one and over-subscribe.
    const devices = all.filter((device) => this.options.hasDriver(device.spec.platform));
    const everyDevice = capacityDevices(all);
    const learned = this.#learnedKinds();
    return {
      admit: {
        boot: (device, down) => {
          const decision = this.options.capacity.canBoot(
            capacityDevice(device),
            down === undefined ? everyDevice : capacityDevices(shutDownIn(all, down)),
          );
          return decision.ok ? undefined : decision.reason;
        },
        create: (spec, down) => {
          const decision = this.options.capacity.canProvision(
            plannedCapacityDevice(spec),
            down === undefined ? everyDevice : capacityDevices(shutDownIn(all, down)),
          );
          return decision.ok ? undefined : decision.reason;
        },
      },
      capacity: this.options.capacity.runningCapacity(everyDevice),
      config: {
        enabled: this.options.config.enabled,
        maxConcurrentBoots: this.options.config.maxConcurrentBoots,
        reserveRunning: this.options.config.reserveRunning,
        shutdownAfterMs: this.options.idle.shutdownAfterMs,
      },
      devices,
      // A `ready` device under a `boot` claim is one handed to a lease, not yet granted.
      handoffInFlight: devices.some(
        (device) =>
          device.state === "ready" && this.options.claims.operationFor(device.id) === "boot",
      ),
      inFlight: [...this.#flights].map((flight) => flight.spec),
      isClaimed: (deviceId) => this.options.claims.isClaimed(deviceId),
      learned,
      leases,
      now: this.options.clock.now(),
      onItsWay: this.#onItsWay(devices),
      resetDevices: new Set(this.#reset),
      retry: this.#schedule,
      spared: this.#spared,
      targets: this.#resolved,
      unplanned: this.#catalogCheck.unanswered(learned).map((kind) => kind.spec),
      waiting: this.options.acquisition.waitingDemand(),
    };
  }

  /**
   * why: a request waits for a device that is `provisioning`, or shut down under an ownerless
   * `boot` claim, so the policy matches those to waiters. A creation in flight has no device until
   * it registers, and counts once: only the flights beyond the spec's `provisioning` devices.
   */
  #onItsWay(devices: readonly VirtualDevice[]): { spec: VirtualSpec; deviceId?: string }[] {
    const entries: { spec: VirtualSpec; deviceId?: string }[] = devices.flatMap((device) => {
      const claim = this.options.claims.claim(device.id);
      const onItsWay =
        (device.state === "provisioning" || device.state === "shutdown") &&
        claim?.kind === "boot" &&
        claim.owner === undefined;
      return onItsWay ? [{ deviceId: device.id, spec: device.spec }] : [];
    });
    const creations = [...this.#flights].filter((flight) => flight.creation);
    for (const [index, flight] of creations.entries()) {
      const earlier = creations
        .slice(0, index)
        .filter((other) => sameSpec(other.spec, flight.spec));
      const registered = entries.filter(
        (entry) =>
          sameSpec(entry.spec, flight.spec) &&
          devices.some((device) => device.id === entry.deviceId && device.state === "provisioning"),
      );
      if (earlier.length >= registered.length) entries.push({ spec: flight.spec });
    }
    return entries;
  }

  async #act(proposal: WarmProposal): Promise<void> {
    if (this.options.acquisition.maintenanceActive) return;
    if (proposal.action === "provision") {
      this.#launch(proposal.target, true, () => this.#provision(proposal.spec, proposal.target));
      return;
    }
    if (proposal.action === "shutdown") {
      // why: a failed shutdown frees nothing, but any other trigger that comes soon would propose it again, so it is held back for a tick. A boot is held back by the retry schedule, which the policy reads before it proposes one.
      if ((this.#retryAfter.get(proposal.deviceId) ?? 0) > this.options.clock.now()) return;
      await this.#shutdown(proposal.deviceId, proposal.reason);
      return;
    }
    const owner = this.#ownerOf(proposal);
    if (owner !== undefined) this.#launch(owner, false, () => this.#boot(proposal.deviceId, owner));
  }

  /** why: the spec a boot or creation is held back by, when it is one of a target's or a waiter's. */
  #ownerOf(proposal: Exclude<WarmProposal, { action: "provision" }>): VirtualSpec | undefined {
    if (proposal.action === "boot" && proposal.reason === "waiting-request") {
      return this.#specOf(proposal.deviceId);
    }
    return proposal.target;
  }

  #specOf(deviceId: string): VirtualSpec | undefined {
    return this.options.registry.snapshot.virtualDevices.find((device) => device.id === deviceId)
      ?.spec;
  }

  /**
   * why: starts a boot or creation for a target or a waiter beside the pass, which does not wait for it: the policy
   * counts it toward `maxConcurrentBoots` until it ends, and its end asks for the next pass when
   * an attempt was made. One that was declined (the device or the budget was gone by then) asks
   * for none: the same view would propose it again at once, and the pool would spin.
   */
  #launch(spec: VirtualSpec, creation: boolean, run: () => Promise<boolean>): void {
    const flight: Flight = { creation, done: Promise.resolve(), spec };
    this.#flights.add(flight);
    flight.done = run()
      .catch((error: unknown) => {
        this.#logger.error("a warm pool boot or creation failed", {
          step: "flight",
          error: stableError(error),
        });
        // Held back like any failure, so the pass it asks for does not try again at once.
        this.#failed(spec);
        return true;
      })
      .then((attempted) => {
        this.#flights.delete(flight);
        if (attempted) this.#trigger();
      });
  }

  async #shutdown(deviceId: string, reason: string): Promise<void> {
    const device = await this.options.decisions.run(() => this.#unleased(deviceId, "ready"));
    if (device === undefined) return;
    try {
      const done = await this.options.lifecycle.shutdown(device, "warm-pool", "cleanup");
      if (done === undefined) return;
      // why: `device.shutdown` carries no reason, so the daemon log is where a shutdown is attributed (safety rule 6).
      this.#logger.info("a warm pool shut a device down", { deviceId, reason });
    } catch (error: unknown) {
      this.#logFailure(device, "shutdown", error);
    }
    this.options.acquisition.kick();
  }

  /**
   * why: boots a shut-down device and reports the outcome to the failure schedule of its owner.
   * Whether a boot was attempted: not when the device is no longer there to boot.
   */
  async #boot(deviceId: string, target: VirtualSpec): Promise<boolean> {
    const held = await this.options.decisions.run(() => {
      const device = this.#unleased(deviceId, "shutdown");
      if (device === undefined) return undefined;
      const reservation = this.options.capacity.tryReserveBoot(
        capacityDevice(device),
        capacityDevices(this.options.registry.snapshot.virtualDevices),
      );
      if (!reservation.ok) return undefined;
      const claim = this.options.claims.tryClaim(device.id, "boot");
      if (claim === undefined) {
        reservation.reservation.release();
        return undefined;
      }
      return { claim, device, reservation: reservation.reservation };
    });
    if (held === undefined) return false;
    try {
      const done = await this.options.lifecycle.bootWarm(held.device, held.claim);
      if (done === undefined) return false;
      this.#schedule.succeeded(target);
    } catch (error: unknown) {
      this.#logFailure(held.device, "boot", error);
      this.#failed(target);
    } finally {
      await this.options.decisions.run(() => {
        held.claim.release();
        held.reservation.release();
      });
    }
    this.options.acquisition.kick();
    return true;
  }

  /**
   * Creates a device for a target and boots it. The reservation is taken in the gate, so the
   * budget sees the device before it exists; the provisioner gives it back. The device is made
   * ready under an ownerless `boot` claim, so a request that serves it may wait on it (#369), and
   * the claim ends once it is ready and unleased.
   */
  async #provision(spec: VirtualSpec, target: VirtualSpec): Promise<boolean> {
    const reservation = await this.options.decisions.run(() => {
      const attempt = this.options.capacity.tryReserveProvisioning(
        plannedCapacityDevice(spec),
        capacityDevices(this.options.registry.snapshot.virtualDevices),
      );
      return attempt.ok ? attempt.reservation : undefined;
    });
    if (reservation === undefined) return false;
    try {
      const handoff = await this.options.provisioner.provision(spec, {
        claim: { kind: "boot" },
        reservation,
      });
      await this.options.decisions.run(() => handoff.claim.release());
      this.#schedule.succeeded(target);
    } catch (error: unknown) {
      this.#logger.warn("warm pool creation of a device failed", {
        model: spec.model,
        step: "provision",
        error: stableError(error),
      });
      this.#failed(target);
    }
    this.options.acquisition.kick();
    return true;
  }

  /** Remembers the failure; the pass the ended flight asks for arms the timer for the retry. */
  #failed(target: VirtualSpec): void {
    this.#schedule.failed(target, this.options.clock.now());
    if (this.#schedule.failures(target) < LEARNED_FAILURES_LIMIT) return;
    if (this.#resolved.some((configured) => sameSpec(configured.spec, target))) return;
    if (!this.#learnedKinds().some((kind) => sameSpec(kind.spec, target))) return;
    this.#recording("forget a kind", () => this.#learned.forget(target));
    this.#schedule.succeeded(target);
    this.#logger.warn("a warm pool learned kind failed three times in a row and was forgotten", {
      model: target.model,
      osVersion: target.osVersion,
      platform: target.platform,
    });
  }

  /** The device, when it is still in `state`, has no lease and no operation claim on it. */
  #unleased(deviceId: string, state: VirtualDevice["state"]): VirtualDevice | undefined {
    const { leases, virtualDevices: devices } = this.options.registry.snapshot;
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (
      device?.state !== state ||
      leases.some((lease) => lease.deviceId === deviceId) ||
      this.options.claims.isClaimed(deviceId)
    ) {
      return undefined;
    }
    return device;
  }

  /** why: only a shutdown pauses its device; a boot is held back by the retry schedule alone. */
  #logFailure(device: VirtualDevice, step: "shutdown" | "boot", error: unknown): void {
    if (step === "shutdown")
      this.#retryAfter.set(device.id, this.options.clock.now() + WARM_POOL_TICK_MS);
    this.#logger.warn(`warm pool ${step} of a device failed`, {
      deviceId: device.id,
      step,
      error: stableError(error),
    });
  }
}

/** why: `devices` with the ones in `down` as they are once shut down, for a capacity question about the plan so far. */
function shutDownIn(devices: readonly VirtualDevice[], down: ReadonlySet<string>): VirtualDevice[] {
  return devices.map((device) => (down.has(device.id) ? { ...device, state: "shutdown" } : device));
}

/**
 * why: the short log and `warm-pool.target-missed` describe the operator's targets only, so a learned kind's report is left out and a merged entry is judged by the
 * configured count: a configured target that is met is not short however short the learned count is.
 */
function configuredOnly(reports: readonly TargetReport[]): TargetReport[] {
  return reports
    .filter((report) => report.origin === "configured")
    .map((report) => {
      if (report.count === report.configuredCount) return report;
      const { short: _short, ...rest } = report;
      const merged = { ...rest, count: report.configuredCount };
      return report.ready >= report.configuredCount || report.short === undefined
        ? merged
        : { ...merged, short: report.short };
    });
}

/** A report as `figures()` lists it: the kind, the numbers and the reason, never the message. */
function figureOf(report: TargetReport): WarmTargetFigures {
  return {
    ...report.kind,
    booting: report.booting,
    count: report.count,
    origin: report.origin,
    ready: report.ready,
    ...(report.spec?.imageTag === undefined ? {} : { imageTag: report.spec.imageTag }),
    ...(report.short === undefined ? {} : { short: report.short }),
  };
}

/** A target as a request: the platform, the exact model, and what it names of OS and mode. */
function requestFor(target: WarmTarget): DeviceRequest {
  return {
    model: target.model,
    platform: target.platform,
    ...(target.osVersion === undefined ? {} : { osVersion: target.osVersion }),
    ...(target.mode === undefined ? {} : { mode: target.mode }),
  };
}

const TRIGGERS = [
  "daemon.started",
  "device.reclaimed",
  "device.quarantine-recovered",
  "lease.granted",
  "lease.released",
  "device.shutdown",
  "device.deleted",
  "cleanup.executed",
  "capacity.changed",
  "lease.queued",
] as const;
