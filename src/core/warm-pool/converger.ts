import type { EventBus } from "../../bus/index.js";
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
  type DeviceRecord,
  type DeviceSpec,
  type LeaseRecord,
  type TargetResolution,
  type WaitingDemand,
} from "../domain.js";
import type { DeviceRequest } from "../driver.js";
import type { ManagedDeviceLifecycle } from "../managed-device-lifecycle.js";
import type { SerializedDecision } from "../serialized-decision.js";
import { stableError } from "../stable-error.js";
import type { WarmPoolConfig, WarmTarget } from "./config.js";
import {
  describeTarget,
  evaluate,
  type ResolvedTarget,
  targetedDevices,
  type TargetReport,
  type WarmProposal,
} from "./policy.js";
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
  };
  readonly capacity: Pick<
    CapacityCoordinator,
    "canBoot" | "canProvision" | "runningCapacity" | "tryReserveBoot" | "tryReserveProvisioning"
  >;
  readonly claims: Pick<DeviceOperationClaims, "isClaimed" | "operationFor" | "tryClaim">;
  readonly clock: Clock;
  readonly config: WarmPoolConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "subscribe">;
  readonly idle: { readonly shutdownAfterMs: number };
  readonly lifecycle: Pick<ManagedDeviceLifecycle, "bootWarm" | "shutdown">;
  readonly logger?: Logger;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly registry: {
    readonly snapshot: {
      readonly devices: readonly DeviceRecord[];
      readonly leases: readonly LeaseRecord[];
    };
  };
}

/** The tick that re-runs a pass when no event does, so a slot freed silently is still used. */
export const WARM_POOL_TICK_MS = 30_000;

/** A target boot or creation that runs beside the pass: the target's spec, and its end. */
interface Flight {
  readonly spec: DeviceSpec;
  done: Promise<void>;
}

/**
 * Observes the bus and runs one pass at a time over the pool: it resolves the operator's targets,
 * reads a snapshot, asks the policy what to shut down, boot and create, and does each through the
 * device lifecycle and the provisioner, revalidating the device first (safety rule 2). A trigger
 * that arrives during a pass asks for one more, not one each.
 *
 * Every action that is attempted ends in `kick()`, whether it worked or not, so a request waiting
 * on a boot the pool started plans again either way; one declined before it began does not. A boot or creation for a target runs beside the pass, up
 * to `maxConcurrentBoots` at a time, and asks for the next pass when it ends.
 */
export class WarmPool {
  readonly #logger: Logger;
  readonly #unsubscribe: (() => void)[] = [];
  /** When a device whose boot or shutdown failed may be tried again, by device id. */
  readonly #retryAfter = new Map<string, number>();
  /** When a target's spec whose boot or creation failed may be tried again. */
  readonly #schedule = new RetrySchedule();
  readonly #flights = new Set<Flight>();
  #again = false;
  #disposed = false;
  /** A graceful stop is draining: what is in flight finishes, and nothing new starts. */
  #draining = false;
  #started = false;
  /** Devices shut down under an operator reset that have not left `shutdown` since. */
  readonly #reset = new Set<string>();
  /** The targets that resolved on the last pass, and every target's state as it left them. */
  #resolved: readonly ResolvedTarget[] | undefined;
  /** The spec each target last resolved to, which a transient refusal does not take away. */
  readonly #lastSpecs = new Map<string, DeviceSpec>();
  #reports: readonly TargetReport[] = [];
  #loggedShort = new Set<string>();
  #retryTimer: TimerHandle | undefined;
  #running: Promise<void> | undefined;
  #tick: TimerHandle | undefined;

  constructor(private readonly options: WarmPoolOptions) {
    this.#logger = options.logger?.child("warm-pool") ?? new NoopLogger();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const event of TRIGGERS) {
      this.#unsubscribe.push(this.options.eventBus.subscribe(event, () => this.#trigger()));
    }
    this.#armTick();
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
    this.#draining = true;
    await this.settle();
  }

  /**
   * The devices the idle shutdown timer leaves alone: for each target, its ready unleased devices
   * of that kind, oldest first, up to its count. Targets not yet resolved by any pass are resolved
   * first, so the reaper's first run after a start does not read an empty set; none with the
   * pool off.
   */
  async targeted(): Promise<ReadonlySet<string>> {
    if (!this.options.config.enabled) return new Set();
    if (this.#resolved === undefined) await this.#resolveTargets();
    const { devices, leases } = this.options.registry.snapshot;
    return targetedDevices({
      devices,
      isClaimed: (deviceId) => this.options.claims.isClaimed(deviceId),
      leases,
      targets: this.#resolved ?? [],
    });
  }

  /** Every target as the last pass left it: how many are ready, and why not more. */
  targets(): readonly TargetReport[] {
    return this.#reports;
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

  async #once(): Promise<void> {
    if (this.#draining) return;
    if (this.options.acquisition.maintenanceActive) {
      // Whatever is shut down under a reset, an iOS device its forced release left that way
      // included, is meant to stay down.
      for (const device of this.options.registry.snapshot.devices) {
        if (device.state === "shutdown") this.#reset.add(device.id);
      }
      return;
    }
    try {
      // A pool that is off keeps no target: nothing is resolved, reported or spared.
      const refused = this.options.config.enabled ? await this.#resolveTargets() : [];
      const plan = await this.options.decisions.run(() => evaluate(this.#view()));
      this.#note([...refused, ...plan.targets]);
      for (const proposal of plan.proposals) {
        if (this.#draining) break;
        await this.#act(proposal);
      }
      this.#armRetry();
    } catch (error: unknown) {
      this.#logger.error("a warm pool pass failed", { step: "pass", error: stableError(error) });
    }
  }

  /**
   * Resolves every target the way a request is resolved. Per pass, so a runtime installed since
   * the last one takes effect without a restart. Returns the reports of the targets that did not
   * resolve; the policy merges the ones that did.
   */
  async #resolveTargets(): Promise<readonly TargetReport[]> {
    const answers = await Promise.all(
      this.options.config.targets.map(async (target) => ({
        resolution: await this.options.acquisition.resolve(requestFor(target)),
        target,
      })),
    );
    const resolved: ResolvedTarget[] = [];
    const refused: TargetReport[] = [];
    for (const { resolution, target } of answers) {
      const key = JSON.stringify(target);
      if ("spec" in resolution) {
        this.#lastSpecs.set(key, resolution.spec);
        resolved.push({ count: target.count, spec: resolution.spec });
        continue;
      }
      // A refusal for any reason but a settled fact (no driver, no such runtime or model) may be a
      // read that failed once: the target keeps the spec it last resolved to, so the pass does not
      // treat its devices as unwanted.
      const last = resolution.refusal === "unresolvable" ? this.#lastSpecs.get(key) : undefined;
      if (last !== undefined) {
        resolved.push({ count: target.count, spec: last });
        continue;
      }
      this.#lastSpecs.delete(key);
      refused.push({
        count: target.count,
        message: resolution.message,
        ready: 0,
        short: resolution.refusal,
        target: describeTarget(target),
      });
    }
    this.#resolved = resolved;
    return refused;
  }

  /** Keeps the reports, and logs a target the first pass it is short for a reason. */
  #note(reports: readonly TargetReport[]): void {
    this.#reports = reports;
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

  #view(): Parameters<typeof evaluate>[0] {
    const { devices, leases } = this.options.registry.snapshot;
    for (const id of this.#reset) {
      if (devices.find((device) => device.id === id)?.state !== "shutdown") this.#reset.delete(id);
    }
    const everyDevice = capacityDevices(devices);
    return {
      admit: {
        boot: (device) => {
          const decision = this.options.capacity.canBoot(capacityDevice(device), everyDevice);
          return decision.ok ? undefined : decision.reason;
        },
        create: (spec) => {
          const decision = this.options.capacity.canProvision(
            plannedCapacityDevice(spec),
            everyDevice,
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
      leases,
      now: this.options.clock.now(),
      resetDevices: new Set(this.#reset),
      retry: this.#schedule,
      targets: this.#resolved ?? [],
      waiting: this.options.acquisition.waitingDemand(),
    };
  }

  async #act(proposal: WarmProposal): Promise<void> {
    if (this.options.acquisition.maintenanceActive) return;
    if (proposal.action === "provision") {
      this.#launch(proposal.target, () => this.#provision(proposal.spec, proposal.target));
      return;
    }
    // A failed step releases its reservation and so triggers the next pass at once; without a
    // pause that would retry a broken boot in a loop.
    if ((this.#retryAfter.get(proposal.deviceId) ?? 0) > this.options.clock.now()) return;
    if (proposal.action === "shutdown") await this.#shutdown(proposal.deviceId);
    else if (proposal.target === undefined) await this.#boot(proposal.deviceId, undefined);
    else {
      const target = proposal.target;
      this.#launch(target, () => this.#boot(proposal.deviceId, target));
    }
  }

  /**
   * Starts a target's boot or creation beside the pass, which does not wait for it: the policy
   * counts it toward `maxConcurrentBoots` until it ends, and its end asks for the next pass when
   * an attempt was made. One that was declined (the device or the budget was gone by then) asks
   * for none: the same view would propose it again at once, and the pool would spin.
   */
  #launch(spec: DeviceSpec, run: () => Promise<boolean>): void {
    const flight: Flight = { done: Promise.resolve(), spec };
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

  async #shutdown(deviceId: string): Promise<void> {
    const device = await this.options.decisions.run(() => this.#unleased(deviceId, "ready"));
    if (device === undefined) return;
    try {
      const done = await this.options.lifecycle.shutdown(device, "warm-pool", "cleanup");
      if (done === undefined) return;
    } catch (error: unknown) {
      this.#logFailure(device, "shutdown", error);
    }
    this.options.acquisition.kick();
  }

  /**
   * Boots a shut-down device; for a target, also reports the outcome to the failure schedule.
   * Whether a boot was attempted: not when the device is no longer there to boot.
   */
  async #boot(deviceId: string, target: DeviceSpec | undefined): Promise<boolean> {
    const held = await this.options.decisions.run(() => {
      const device = this.#unleased(deviceId, "shutdown");
      if (device === undefined) return undefined;
      const reservation = this.options.capacity.tryReserveBoot(
        capacityDevice(device),
        capacityDevices(this.options.registry.snapshot.devices),
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
      if (target !== undefined) this.#schedule.succeeded(target);
    } catch (error: unknown) {
      this.#logFailure(held.device, "boot", error);
      if (target !== undefined) this.#failed(target);
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
  async #provision(spec: DeviceSpec, target: DeviceSpec): Promise<boolean> {
    const reservation = await this.options.decisions.run(() => {
      const attempt = this.options.capacity.tryReserveProvisioning(
        plannedCapacityDevice(spec),
        capacityDevices(this.options.registry.snapshot.devices),
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
  #failed(target: DeviceSpec): void {
    this.#schedule.failed(target, this.options.clock.now());
  }

  /** The device, when it is still in `state`, has no lease and no operation claim on it. */
  #unleased(deviceId: string, state: DeviceRecord["state"]): DeviceRecord | undefined {
    const { devices, leases } = this.options.registry.snapshot;
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

  #logFailure(device: DeviceRecord, step: "shutdown" | "boot", error: unknown): void {
    this.#retryAfter.set(device.id, this.options.clock.now() + WARM_POOL_TICK_MS);
    this.#logger.warn(`warm pool ${step} of a device failed`, {
      deviceId: device.id,
      step,
      error: stableError(error),
    });
  }
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
] as const;
