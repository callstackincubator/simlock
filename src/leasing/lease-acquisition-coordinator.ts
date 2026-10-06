import type { EventBus, EventMap } from "../bus/index.js";
import { requestedClass } from "../contract/index.js";
import {
  compareVersions,
  type OsRange,
  parseOsConstraint,
  satisfies,
} from "../contract/os-range.js";
import { type IdGenerator, type Logger, NoopLogger } from "../ports/index.js";
import {
  type CapacityReservation,
  type DeviceOperationClaim,
  type DeviceOperationClaims,
  type DeviceProvisioner,
  classCandidates,
  findCatalogModel,
  modelClass,
  pairedRuntimes,
  type DeviceClass,
  type DeviceMode,
  type DeviceRecord,
  type DeviceRequirement,
  type DeviceSpec,
  exactRequirement,
  type LeaseGrant,
  type LeaseProgress,
  type LeaseRecord,
  type LeaseTiming,
  newLeaseRequestId,
  type Platform,
  sameSpec,
  specMode,
  ComponentBeingRemovedError,
  type ComponentInstaller,
  type ComponentInstallerProgress,
  BootTimeoutError,
  type DeviceRequest,
  type Driver,
  type DriverCatalogEntry,
  type ExactDeviceRequest,
  RuntimeMissingError,
  UnknownModelError,
  type DriverCatalog,
  type ModelPreferences,
  type CatalogReader,
  type AcquisitionMaintenance,
  type ManagedDeviceLifecycle,
  type ReadyDeviceHandoff,
  type SerializedDecision,
  stableError,
  type WaitingDemand,
} from "../core/index.js";
import { type AcquisitionPlan, type AcquisitionPlanner } from "./acquisition-planner.js";
import { type LeaseRequestBook } from "./lease-request-book.js";
import { type LeaseLifecycle } from "./lease-lifecycle.js";
import {
  type LeaseRequestOptions,
  RequestCancelledError,
  RequesterAlreadyLeasedError,
  type Waiter,
  type WaitQueue,
} from "./wait-queue.js";

export type { LeaseRequestOptions } from "./wait-queue.js";

export class NoCapacityError extends Error {
  constructor() {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

class NukeCancelledError extends Error {
  constructor() {
    super("Request cancelled by nuke");
    this.name = "NukeCancelledError";
  }
}

export interface LeaseAcquisitionRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export type AcquisitionClaims = Pick<DeviceOperationClaims, "isClaimed" | "tryClaim">;
export type AcquisitionDecision = Pick<SerializedDecision, "run">;
export type AcquisitionDrivers = Pick<DriverCatalog, "get">;
export type AcquisitionPlannerPort = Pick<AcquisitionPlanner, "plan">;
export type AcquisitionQueue = Pick<
  WaitQueue,
  | "create"
  | "cancelAll"
  | "depth"
  | "enqueue"
  | "findPendingWaiter"
  | "hasPendingRequester"
  | "head"
  | "isQueued"
  | "markNew"
  | "markProcessing"
  | "notifyProgress"
  | "pending"
  | "reject"
  | "resolve"
>;

export interface LeaseAcquisitionCoordinatorOptions {
  /** Read for a request that names a class: which models the host lists, and which runtimes. */
  readonly catalog: Pick<CatalogReader, "listCatalog">;
  readonly claims: AcquisitionClaims;
  /**
   * The one installer in the core (ADR 0010 §3). A request whose runtime is missing and that
   * may download calls it directly (architecture rule 5); nothing else on this path installs.
   */
  readonly components: Pick<ComponentInstaller, "install">;
  readonly decisions: AcquisitionDecision;
  /**
   * The worker's default device mode per platform, built from config at the composition root
   * (ADR 0007 §2). A platform it does not name defaults to `"full"`.
   */
  readonly defaultModes: Readonly<Partial<Record<Platform, DeviceMode>>>;
  readonly drivers: AcquisitionDrivers;
  readonly eventBus: Pick<EventBus, "emit">;
  /** Mints a request's id before admission checks, so a request refused there still has one. */
  readonly idGenerator: IdGenerator;
  readonly leases: Pick<LeaseLifecycle, "grant">;
  readonly lifecycle: Pick<
    ManagedDeviceLifecycle,
    "bootForLease" | "destroy" | "dispose" | "shutdown"
  >;
  /**
   * The model names to try for each class, per platform, operator's list first (ADR 0015 §4),
   * built at the composition root. This coordinator holds no model name of its own.
   */
  readonly modelPreferences: ModelPreferences;
  readonly planner: AcquisitionPlannerPort;
  readonly provisioner: Pick<DeviceProvisioner, "provision">;
  readonly queue: AcquisitionQueue;
  readonly registry: LeaseAcquisitionRegistry;
  readonly logger?: Logger;
  /** Stores each request before it is queued and answers repeats of it (`LeaseRequestBook`). */
  readonly requests: Pick<LeaseRequestBook<LeaseGrant>, "admit" | "replay">;
}

interface AcquisitionWaiter extends Waiter {
  failures: number;
  /** What an idle device must satisfy besides its pool mode, kept beside `spec` (ADR 0015 §5). */
  classOf?: ((model: string) => DeviceClass | undefined) | undefined;
  requirement?: DeviceRequirement | undefined;
  spec?: DeviceSpec;
  timing: LeaseTiming;
}

/** The kinds of plan that end in a grant. An eviction never does: the plan made after it does. */
type GrantingPlanKind = "grant-ready" | "boot-shutdown" | "provision";

/** The one place a plan's kind becomes the `source` a `lease.granted` reports. */
const GRANT_SOURCE: Readonly<Record<GrantingPlanKind, EventMap["lease.granted"]["source"]>> = {
  "boot-shutdown": "booted",
  "grant-ready": "warm",
  provision: "provisioned",
};

type OperationPlan = Exclude<
  AcquisitionPlan,
  { readonly kind: "grant-ready" | "wait" | "no-capacity" }
>;

const noTiming: LeaseTiming = {
  estimatedBootMs: 0,
  estimatedProvisionMs: 0,
  estimatedReclaimMs: 0,
  estimatedReadyMs: 0,
};

/** Coordinates admission, planning, device work, and queue settlement for acquisition only. */
export class LeaseAcquisitionCoordinator implements AcquisitionMaintenance {
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #driving = new WeakSet<AcquisitionWaiter>();
  #admissionClosed = false;
  #maintenanceDepth = 0;
  readonly #logger: Logger;

  constructor(private readonly options: LeaseAcquisitionCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-acquisition-coordinator") ?? new NoopLogger();
  }

  get queueDepth(): number {
    return this.options.queue.depth;
  }

  /**
   * Whether a device with this spec is in the pool a request naming no mode draws from: its pool
   * mode (the spec's mode, full when it names none) is the platform's default mode (ADR 0009 §6).
   */
  servesDefaultMode(spec: DeviceSpec): boolean {
    return specMode(spec) === this.#defaultMode(spec.platform);
  }

  /** The one place a platform's default mode is read (ADR 0007 §2): full when none is set. */
  #defaultMode(platform: Platform): DeviceMode {
    return this.options.defaultModes[platform] ?? "full";
  }

  /**
   * The session principal a pending request was created under (ADR §4: `ownerId` on
   * `LeaseRequestOptions`, always the session principal, never the caller-suppliable
   * `requesterId`). `undefined` when no pending request exists for this requester id --
   * `cancelPending`'s own `not-found` outcome is what surfaces that, not this lookup, so a
   * caller cancelling a request that already settled (or never existed) is not authorized on
   * a manufactured owner. A synchronous read like `queueDepth`, not routed through
   * `decisions.run`: no state is asserted or mutated, and `#leaseCancel`'s contract-level
   * `authorize` hook (ADR §2 step 3) runs before the handler, so it cannot go through the
   * handler's own serialized decision anyway.
   */
  pendingRequestOwner(requesterId: string): string | undefined {
    return this.options.queue.findPendingWaiter(requesterId)?.options.ownerId;
  }

  /**
   * Admits a request, or answers a repeat of one. A repeat under a stored key is answered before
   * any other check -- its result never depends on what changed on the host since. A new
   * request is stored before the queue sees it, inside the same serialized section as the
   * one-request-per-requester check, so two concurrent requests under one key cannot both pass.
   */
  async request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    let admitted: { readonly waiter: AcquisitionWaiter } | { readonly replay: Promise<LeaseGrant> };
    try {
      admitted = await this.options.decisions.run(async () => {
        const replay = this.options.requests.replay(request, options);
        if (replay !== undefined) return { replay };
        const requestId = newLeaseRequestId(this.options.idGenerator);
        if (this.#admissionClosed) {
          this.options.eventBus.emit(
            "lease.rejected",
            {
              requestId,
              requester: options.requesterId,
              requestSpec: request,
              reason: "killed",
            },
            "lease-acquisition-coordinator",
          );
          throw new NukeCancelledError();
        }
        const activeLease = this.options.registry.snapshot.leases.find(
          (lease) => lease.requesterId === options.requesterId,
        );
        if (
          activeLease !== undefined ||
          this.options.queue.hasPendingRequester(options.requesterId)
        ) {
          this.options.eventBus.emit(
            "lease.rejected",
            {
              requestId,
              requester: options.requesterId,
              requestSpec: request,
              reason: "already-leased",
            },
            "lease-acquisition-coordinator",
          );
          throw new RequesterAlreadyLeasedError(options.requesterId, activeLease?.id);
        }
        const { id, started: accepted } = await this.options.requests.admit(
          request,
          options,
          (id, onProgress) => this.#newWaiter(request, { ...options, onProgress }, id),
          requestId,
        );
        this.options.eventBus.emit(
          "lease.requested",
          {
            requestId: id,
            requestSpec: request,
            requester: options.requesterId,
            waitPolicy: options.noWait ? "no-wait" : "wait",
          },
          "lease-acquisition-coordinator",
        );
        return { waiter: accepted };
      });
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    if ("replay" in admitted) return admitted.replay;
    const { waiter } = admitted;
    this.#track(this.#resolveAndDrive(waiter, request, options));
    return waiter.promise;
  }

  /** Closes acquisition admission, settles all demand, and drains driver work. */
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#maintenanceDepth += 1;
      this.#admissionClosed = true;
      for (const waiter of this.options.queue.cancelAll(() => new NukeCancelledError())) {
        this.options.eventBus.emit(
          "lease.rejected",
          {
            requestId: waiter.id,
            requester: waiter.options.requesterId,
            requestSpec: waiter.request,
            reason: "killed",
          },
          "lease-acquisition-coordinator",
        );
      }
    });
    while (this.#activeWorkflows.size > 0) {
      await Promise.allSettled(this.#activeWorkflows);
    }
  }

  /** Reopens acquisition admission after an administrative maintenance operation. */
  async endMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#maintenanceDepth = Math.max(0, this.#maintenanceDepth - 1);
      this.#admissionClosed = this.#maintenanceDepth > 0;
    });
  }

  async #resolveAndDrive(
    waiter: AcquisitionWaiter,
    request: DeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<void> {
    let driver: Driver;
    try {
      driver = this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }
    try {
      // The one place a request with no mode gets the worker's default (ADR 0007 §2).
      const mode = request.mode ?? this.#defaultMode(request.platform);
      const range = requestedRange(request);
      const target =
        range === undefined
          ? (this.#exactTarget(request, mode) ?? (await this.#resolveClass(request, mode)))
          : await this.#resolveRanged(request, mode, range);
      // A range was settled against the catalog above, so it never installs (ADR 0015 §5).
      const resolved = await this.#resolveOrInstall(waiter, driver, target.exact, {
        ...options,
        allowDownload: options.allowDownload === true && range === undefined,
      });
      waiter.spec = checkedSpec(resolved, request, mode);
      waiter.requirement = target.requirement ?? exactRequirement(waiter.spec);
      waiter.classOf = target.classOf;
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }

    await this.#drive(waiter);
  }

  /**
   * The exact request an exact-model request already is, answered without awaiting anything so
   * its path takes no extra turn of the event loop; `undefined` for one that names no model.
   */
  #exactTarget(request: DeviceRequest, mode: DeviceMode): ResolvedTarget | undefined {
    const { class: _class, model, ...rest } = request;
    return model === undefined ? undefined : { exact: { ...rest, mode, model } };
  }

  /**
   * Turns a request that names no model, or names an OS range, into the exact one a driver
   * resolves (ADR 0015 §5). A class, named or meant by naming nothing, becomes the first model
   * on its preference list that this host's catalog lists, classes as that class, and pairs with
   * an installed runtime (of the requested image tag, and in the requested range, when it names
   * them); an exact model with a range must be listed, or the request fails as
   * `UnknownModelError`. With a range the runtime is the newest paired one in it, passed on as an
   * exact version. The catalog is read, and nothing is downloaded. A class with no listed model
   * fails as `UnknownModelError`, and a model or class with no pairing as a `RuntimeMissingError`
   * no download can fix.
   */
  async #resolveClass(
    request: DeviceRequest,
    mode: DeviceMode,
    range?: OsRange,
  ): Promise<ResolvedTarget> {
    const deviceClass = requestedClass({ class: request.class });
    const entry = (await this.options.catalog.listCatalog(request.platform))[0];
    if (entry === undefined) throw new UnknownModelError(request.platform, undefined, deviceClass);
    const candidates = classCandidates(
      entry,
      deviceClass,
      this.options.modelPreferences[request.platform]?.[deviceClass] ?? [],
    );
    if (candidates.length === 0) {
      throw new UnknownModelError(request.platform, undefined, deviceClass);
    }
    const chosen = candidates.find(
      (candidate) => matchingRuntimes(entry, candidate, request, range).length > 0,
    );
    if (chosen === undefined) {
      throw new RuntimeMissingError(request.platform, request.osVersion ?? "default");
    }
    return {
      ...this.#rangedTarget(
        entry,
        chosen,
        { class: deviceClass, kind: "class" },
        request,
        mode,
        range,
      ),
      classOf: (candidate) => modelClass(entry, candidate),
    };
  }

  /** A request that names a model and an OS range: the model must be listed (ADR 0015 §5). */
  async #resolveRanged(
    request: DeviceRequest,
    mode: DeviceMode,
    range: OsRange,
  ): Promise<ResolvedTarget> {
    if (request.model === undefined) return this.#resolveClass(request, mode, range);
    const entry = (await this.options.catalog.listCatalog(request.platform))[0];
    if (entry === undefined) throw new UnknownModelError(request.platform, request.model);
    const listed = findCatalogModel(entry, request.model);
    if (listed === undefined) throw new UnknownModelError(request.platform, request.model);
    return this.#rangedTarget(
      entry,
      listed,
      { kind: "model", model: listed },
      request,
      mode,
      range,
    );
  }

  /** The target for `model` once the request's runtime constraints are settled against `entry`. */
  #rangedTarget(
    entry: DriverCatalogEntry,
    model: string,
    target: DeviceRequirement["target"],
    request: DeviceRequest,
    mode: DeviceMode,
    range: OsRange | undefined,
  ): ResolvedTarget {
    const { class: _class, model: _model, ...rest } = request;
    return {
      exact: {
        ...rest,
        mode,
        model,
        ...(range === undefined ? {} : { osVersion: newestRuntime(entry, model, request, range) }),
      },
      requirement: {
        imageTag: request.imageTag,
        osVersion: requiredOs(entry, request, range),
        platform: request.platform,
        target,
      },
    };
  }

  /**
   * Resolves the request; when its runtime is missing, a download could supply it, and the
   * request may download, asks the installer for it and resolves once more. The installer skips
   * the install when, by the time this call reaches the front of its queue, `resolveSpec` no
   * longer fails with `RuntimeMissingError` -- another install made the runtime available.
   * Without `allowDownload` the first failure stands and the installer is never called.
   *
   * The installer's reports reach the requester as the `downloading` stage, through the queue
   * like every other stage. A report equal to the last one sent is skipped, so a percentage is
   * sent once per whole number.
   */
  async #resolveOrInstall(
    waiter: AcquisitionWaiter,
    driver: Driver,
    request: ExactDeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<DeviceSpec> {
    try {
      return await driver.resolveSpec(request);
    } catch (error: unknown) {
      if (
        !(error instanceof RuntimeMissingError) ||
        !error.downloadable ||
        error.component === undefined ||
        options.allowDownload !== true
      ) {
        throw error;
      }
      const { component } = error;
      let lastSent: DownloadingProgress | undefined;
      await this.options.components.install({
        component,
        onProgress: (progress) => {
          const next = downloadingProgress(component, progress);
          if (lastSent !== undefined && sameDownloadingProgress(lastSent, next)) return;
          lastSent = next;
          this.options.queue.notifyProgress(waiter, next);
        },
        platform: request.platform,
        requesterId: options.requesterId,
        stillNeeded: async () => {
          try {
            await driver.resolveSpec(request);
            return false;
          } catch (stillMissing: unknown) {
            return stillMissing instanceof RuntimeMissingError;
          }
        },
      });
      return driver.resolveSpec(request);
    }
  }

  /**
   * Cancels a single pending request. Reuses the queue timeout's safety envelope exactly:
   * only a waiter still in `queued` state is safe to reject here. `processing` means device
   * work already claimed it (provision/boot/evict in flight, possibly never having touched
   * the FIFO list at all on a first-attempt direct dispatch) -- the same state the timeout
   * timer leaves untouched -- so this reports `not-cancellable` rather than inventing a new
   * rule for tearing down in-flight driver work; nuke's `cancelAll` already owns that harder
   * problem, with its own drain of `#activeWorkflows`.
   */
  async cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.options.decisions.run(async () => {
      const waiter = this.options.queue.findPendingWaiter(requesterId) as
        | AcquisitionWaiter
        | undefined;
      if (waiter === undefined) return "not-found";
      if (waiter.state !== "queued") return "not-cancellable";
      this.#reject(waiter, new RequestCancelledError(waiter.id), "cancelled");
      return "cancelled";
    });
  }

  /**
   * The requests that have no device yet, oldest first, whose spec has resolved: those in state
   * `new` or `queued` are waiting; one in `processing` has device work in flight, a provision, boot
   * or eviction, and is marked `inFlight`. The warm pool's read port; the wire-shaped
   * `Leasing#waitingRequests` is a different view and does not change.
   */
  // fallow-ignore-next-line unused-class-member -- reached through the warm pool's acquisition port, which structural typing hides from the analyzer.
  waitingDemand(): readonly WaitingDemand[] {
    return (this.options.queue.pending() as readonly AcquisitionWaiter[]).flatMap((waiter) =>
      waiter.spec === undefined
        ? []
        : [
            {
              classOf: waiter.classOf ?? (() => undefined),
              inFlight: waiter.state === "processing",
              mode: specMode(waiter.spec),
              platform: waiter.spec.platform,
              requirement: waiter.requirement ?? exactRequirement(waiter.spec),
            },
          ],
    );
  }

  /** Whether an administrative reset holds acquisition closed; the warm pool does nothing meanwhile. */
  // fallow-ignore-next-line unused-class-member -- reached through the warm pool's acquisition port, which structural typing hides from the analyzer.
  get maintenanceActive(): boolean {
    return this.#admissionClosed;
  }

  /** Direct availability notification for release, cleanup, and queue-timeout callers. */
  kick(): void {
    this.#wakeQueue();
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    if (this.#driving.has(waiter)) return;
    this.#driving.add(waiter);
    try {
      const action = await this.options.decisions.run(async () => this.#decide(waiter));
      await this.#perform(waiter, action);
    } finally {
      this.#driving.delete(waiter);
    }
  }

  async #perform(waiter: AcquisitionWaiter, action: OperationPlan | undefined): Promise<void> {
    if (action === undefined) return;
    if (action.kind === "provision") {
      const spec = waiter.spec;
      if (spec === undefined) {
        action.reservation.release();
        return;
      }
      waiter.timing = estimatedTiming(this.options.drivers.get(spec.platform), spec);
      await this.#provision(waiter, action.reservation);
      return;
    }
    if (action.kind === "boot-shutdown") {
      waiter.timing = estimatedBootTiming(
        this.options.drivers.get(action.device.spec.platform),
        action.device.spec,
      );
      await this.#bootShutdown(waiter, action.device, action.capacityReservation, action.claim);
      return;
    }
    if (action.kind === "evict-running") {
      await this.#evictRunning(waiter, action.device, action.claim);
      return;
    }
    await this.#evictManaged(waiter, action.device, action.claim);
  }

  async #provision(waiter: AcquisitionWaiter, reservation: CapacityReservation): Promise<void> {
    const spec = waiter.spec;
    if (spec === undefined) {
      reservation.release();
      return;
    }
    let handoff: ReadyDeviceHandoff;
    try {
      handoff = await this.options.provisioner.provision(spec, {
        onProgress: (progress) => this.options.queue.notifyProgress(waiter, progress),
        reservation,
      });
    } catch (error: unknown) {
      if (error instanceof BootTimeoutError) {
        await this.options.decisions.run(async () => {
          if (waiter.state !== "rejected") this.#reject(waiter, error, "boot-timeout");
        });
        this.#wakeQueue();
        return;
      }
      // The spec resolved to a component being removed (ADR 0010 §8): no device was created,
      // and none will be on it, so the request ends as `RUNTIME_MISSING` rather than retrying.
      if (error instanceof ComponentBeingRemovedError) {
        await this.options.decisions.run(async () => {
          if (waiter.state !== "rejected") this.#reject(waiter, error, "unresolvable-spec");
        });
        this.#wakeQueue();
        return;
      }
      const retry = await this.options.decisions.run(async () => {
        if (waiter.state === "rejected") return false;
        waiter.failures += 1;
        if (waiter.failures === 1) {
          this.options.queue.markNew(waiter);
          return true;
        }
        this.#enqueue(waiter);
        return false;
      });
      if (retry) {
        this.#driving.delete(waiter);
        await this.#drive(waiter);
      }
      return;
    }
    await this.#grantHandoff(waiter, handoff, "provision");
  }

  async #decide(waiter: AcquisitionWaiter): Promise<OperationPlan | undefined> {
    if (this.#admissionClosed && waiter.state !== "rejected") {
      this.#reject(waiter, new NukeCancelledError(), "killed");
      return undefined;
    }
    const plan = this.#nextPlan(waiter);
    if (plan === undefined) return undefined;
    if (plan.kind === "grant-ready") {
      waiter.timing = grantReadyTiming(
        this.options.drivers.get(plan.device.spec.platform),
        plan.device.spec,
      );
      await this.#grant(waiter, plan.device.id, plan.kind);
      return undefined;
    }
    const operation = operationPlan(plan);
    if (operation === undefined) {
      this.#defer(waiter);
      return undefined;
    }
    this.options.queue.markProcessing(waiter);
    return operation;
  }

  #nextPlan(waiter: AcquisitionWaiter): AcquisitionPlan | undefined {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    if (this.options.queue.head !== undefined && this.options.queue.head !== waiter) {
      return waiter.options.noWait ? { kind: "no-capacity" } : { kind: "wait" };
    }
    return this.options.planner.plan({
      failures: waiter.failures,
      noWait: waiter.options.noWait ?? false,
      snapshot: this.options.registry.snapshot,
      spec: waiter.spec,
      requirement: waiter.requirement,
      classOf: waiter.classOf,
    });
  }

  /**
   * The one place a `LeaseGrant` is built, which is why the lease environment is read
   * here: every acquisition path -- ready device, fresh provision, boot, eviction -- funnels
   * through it, so there is no second construction site to keep in step.
   */
  async #grant(waiter: AcquisitionWaiter, deviceId: string, kind: GrantingPlanKind): Promise<void> {
    const { device, lease } = await this.options.leases.grant({
      deviceId,
      ownerId: waiter.options.ownerId,
      requestId: waiter.id,
      requesterId: waiter.options.requesterId,
      source: GRANT_SOURCE[kind],
      ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
    });
    this.options.queue.resolve(waiter, {
      device,
      environment: this.options.drivers.get(device.spec.platform).leaseEnvironment(),
      lease,
      timing: waiter.timing,
    });
  }

  async #evictRunning(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const shutdown = await this.options.lifecycle.shutdown(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (shutdown === undefined)
        throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch (error: unknown) {
      this.#logFailure(
        "shutting down an eviction target failed",
        waiter,
        device,
        "shutdown",
        error,
      );
      await this.options.decisions.run(async () => {
        claim.release();
        this.#defer(waiter);
      });
      return;
    }
    await this.#continueAfterEviction(waiter, claim);
  }

  async #evictManaged(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      const deleted = await this.options.lifecycle.dispose(
        device,
        "warm-pool-active-demand",
        "eviction",
        claim,
      );
      if (deleted === undefined) throw new Error(`Eviction target is no longer safe: ${device.id}`);
    } catch (error: unknown) {
      this.#logFailure("deleting an eviction target failed", waiter, device, "delete", error);
      await this.options.decisions.run(async () => {
        claim.release();
        this.#defer(waiter);
      });
      return;
    }
    await this.#continueAfterEviction(waiter, claim);
  }

  async #continueAfterEviction(
    waiter: AcquisitionWaiter,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const next = await this.options.decisions.run(async () => {
      claim.release();
      this.options.queue.markNew(waiter);
      return this.#decide(waiter);
    });
    await this.#perform(waiter, next);
  }

  /** One `warn` line for a device step that failed in the background and is handled here by
   * deferring the waiter or destroying the device. The waiter only ever sees a generic outcome. */
  #logFailure(
    message: string,
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    step: string,
    error: unknown,
  ): void {
    this.#logger.warn(message, {
      deviceId: device.id,
      requesterId: waiter.options.requesterId,
      step,
      error: stableError(error),
    });
  }

  async #bootShutdown(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    capacityReservation: CapacityReservation,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    let handoff: ReadyDeviceHandoff;
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: driver.estimate({ operation: "boot" }, device.spec),
      });
      const ready = await this.options.lifecycle.bootForLease(device, claim);
      if (ready === undefined) throw new Error(`Boot target is no longer safe: ${device.id}`);
      handoff = ready;
    } catch (error: unknown) {
      this.#logFailure(
        "booting a shut-down device for a waiter failed",
        waiter,
        device,
        "boot",
        error,
      );
      let destroyed = true;
      try {
        destroyed =
          (await this.options.lifecycle.destroy(device, "lease-engine", "boot")) !== undefined;
      } catch (destroyError: unknown) {
        this.#logFailure(
          "destroying a device that failed to boot failed",
          waiter,
          device,
          "destroy",
          destroyError,
        );
        destroyed = false;
      }
      await this.options.decisions.run(async () => {
        if (destroyed) capacityReservation.release();
        else if (!this.options.claims.isClaimed(device.id))
          this.options.claims.tryClaim(device.id, "boot");
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      if (destroyed) this.#wakeQueue();
      return;
    }
    await this.#grantHandoff(waiter, handoff, "boot-shutdown", capacityReservation);
  }

  #defer(waiter: AcquisitionWaiter): void {
    if (waiter.options.noWait) {
      this.#reject(waiter, new NoCapacityError(), "no-wait");
      return;
    }
    this.#enqueue(waiter);
    this.#notifyReclaimWait(waiter);
  }

  /**
   * A queued waiter whose spec matches a device already being reclaimed is waiting on that
   * reclaim, not on nothing in particular: an iOS erase holds the only matching device for
   * tens of seconds, and reporting only `queued` leaves the requester with a position and no
   * sense of how long. Purely informational -- the plan is untouched. When the reclaim
   * commits, the waiter is planned again like any other: an Android device comes back
   * `ready` and is granted at once, an iOS one comes back `shutdown` and is granted
   * through a `boot-shutdown` plan, a full boot after the erase. Nothing is reported
   * when no matching device is reclaiming, so this never invents a stage out of an idle wait.
   */
  #notifyReclaimWait(waiter: AcquisitionWaiter): void {
    const spec = waiter.spec;
    if (spec === undefined) return;
    const reclaiming = this.options.registry.snapshot.devices.some(
      (device) => device.state === "reclaiming" && sameSpec(device.spec, spec),
    );
    if (!reclaiming) return;
    this.options.queue.notifyProgress(waiter, {
      etaMs: releaseReclaimEstimateMs(this.options.drivers.get(spec.platform), spec),
      stage: "reclaiming",
    });
  }

  /**
   * Wakes the queue after a grant as well as after a waiter that was rejected meanwhile: a
   * request that planned while this device was still being readied may have queued only
   * because this waiter held the head of the queue or because the capacity reservation
   * released here still counted.
   */
  async #grantHandoff(
    waiter: AcquisitionWaiter,
    handoff: ReadyDeviceHandoff,
    kind: GrantingPlanKind,
    capacityReservation?: CapacityReservation,
  ): Promise<void> {
    await this.options.decisions.run(async () => {
      try {
        if (waiter.state === "rejected") return;
        await this.#grant(waiter, handoff.device.id, kind);
      } finally {
        capacityReservation?.release();
        handoff.claim.release();
      }
    });
    this.#wakeQueue();
  }

  #enqueue(waiter: AcquisitionWaiter): void {
    const alreadyQueued = this.options.queue.isQueued(waiter);
    if (this.options.queue.enqueue(waiter) && !alreadyQueued) {
      this.options.eventBus.emit(
        "lease.queued",
        { queuePosition: this.options.queue.depth, requestId: waiter.id },
        "lease-acquisition-coordinator",
      );
    }
  }

  #reject(
    waiter: AcquisitionWaiter,
    error: Error,
    reason:
      | "timeout"
      | "no-wait"
      | "unresolvable-spec"
      | "already-leased"
      | "boot-timeout"
      | "killed"
      | "cancelled",
  ): void {
    if (this.options.queue.reject(waiter, error)) {
      this.options.eventBus.emit(
        "lease.rejected",
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason,
        },
        "lease-acquisition-coordinator",
      );
    }
  }

  #wakeQueue(): void {
    void this.options.decisions.run(async () => {
      const next = this.options.queue.head as AcquisitionWaiter | undefined;
      if (next !== undefined && next.state === "queued") this.#track(this.#drive(next));
    });
  }

  #track(workflow: Promise<void>): void {
    this.#activeWorkflows.add(workflow);
    void workflow.then(
      () => this.#activeWorkflows.delete(workflow),
      () => this.#activeWorkflows.delete(workflow),
    );
  }

  #newWaiter(request: DeviceRequest, options: LeaseRequestOptions, id: string): AcquisitionWaiter {
    return Object.assign(this.options.queue.create(request, options, id), {
      failures: 0,
      timing: noTiming,
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function estimatedTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedProvisionMs = driver.estimate({ operation: "provision" }, spec);
  const estimatedBootMs = driver.estimate({ operation: "boot" }, spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedProvisionMs + estimatedBootMs,
  };
}

function estimatedBootTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  const estimatedBootMs = driver.estimate({ operation: "boot" }, spec);
  return {
    estimatedBootMs,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: estimatedBootMs,
  };
}

/** A device that is already ready costs nothing to hand over; only its reclaim lies ahead. */
function grantReadyTiming(driver: Driver, spec: DeviceSpec): LeaseTiming {
  return {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReclaimMs: releaseReclaimEstimateMs(driver, spec),
    estimatedReadyMs: 0,
  };
}

/**
 * What this device's reclaim will cost once the lease is released -- the one part of a
 * grant's timing that describes work still ahead of the holder rather than work already
 * done. `standard` because that is what every release path asks for (`ReclaimCoordinator
 * #reclaim`, `QuarantineCoordinator`); a holder cannot request a different clean level.
 */
function releaseReclaimEstimateMs(driver: Driver, spec: DeviceSpec): number {
  return driver.estimate({ clean: "standard", operation: "reclaim" }, spec);
}

function operationPlan(plan: AcquisitionPlan): OperationPlan | undefined {
  return plan.kind === "grant-ready" || plan.kind === "wait" || plan.kind === "no-capacity"
    ? undefined
    : plan;
}

/** The spec without a planned mode: the full spec of the same model and runtime. */
function fullSpec(spec: DeviceSpec): DeviceSpec {
  if (spec.mode === undefined) return spec;
  const { mode: _mode, ...full } = spec;
  return full;
}

type DownloadingProgress = Extract<LeaseProgress, { readonly stage: "downloading" }>;

/**
 * The installer's report in the requester's words. `waiting` is a request still behind another
 * install; `downloading` is its own install running, with the installer's percentage (already
 * within 0..100) rounded down to a whole number.
 */
function downloadingProgress(
  component: string,
  progress: ComponentInstallerProgress,
): DownloadingProgress {
  if (progress.stage === "waiting") return { component, stage: "downloading", waiting: true };
  const { percent } = progress;
  return percent === undefined
    ? { component, stage: "downloading", waiting: false }
    : { component, percent: Math.floor(percent), stage: "downloading", waiting: false };
}

/** Both reports are for the one component a `#resolveOrInstall` call downloads. */
function sameDownloadingProgress(left: DownloadingProgress, right: DownloadingProgress): boolean {
  return left.waiting === right.waiting && left.percent === right.percent;
}

/**
 * The spec a driver resolved, held to what the request asked. The image tag is the request's, or
 * none: a driver that returns another, or one the request did not name, would plan the device
 * into a pool the request did not ask for. Full is a guarantee (ADR 0007 §5): a slim spec is
 * accepted only for a slim request, so a driver that returns the wrong thing still cannot put a
 * full request on a slim device.
 */
function checkedSpec(resolved: DeviceSpec, request: DeviceRequest, mode: DeviceMode): DeviceSpec {
  if (resolved.imageTag !== request.imageTag) {
    throw new Error(
      `The ${request.platform} driver resolved image tag ${String(resolved.imageTag)} ` +
        `for a request naming ${String(request.imageTag)}`,
    );
  }
  return mode === "slim" ? resolved : fullSpec(resolved);
}

/** What `#resolveClass` settles on; an exact request has only `exact`. */
interface ResolvedTarget {
  readonly exact: ExactDeviceRequest;
  readonly requirement?: DeviceRequirement;
  readonly classOf?: (model: string) => DeviceClass | undefined;
}

/**
 * The installed runtimes a model pairs with that the request accepts: the one it names, or those
 * in its range, or any when it names none; and only runtimes that have an image of the requested
 * tag when it names one (the rule the gateway's `matchRequest` applies).
 */
function matchingRuntimes(
  entry: DriverCatalogEntry,
  model: string,
  { imageTag, osVersion }: Pick<DeviceRequest, "imageTag" | "osVersion">,
  range: OsRange | undefined,
): string[] {
  return pairedRuntimes(entry, model).filter(
    (runtime) =>
      (range === undefined
        ? osVersion === undefined || runtime === osVersion
        : satisfies(runtime, range)) &&
      (imageTag === undefined ||
        (entry.images ?? []).some((image) => image.runtime === runtime && image.tag === imageTag)),
  );
}

/** The newest runtime `model` pairs with that the request's range accepts, or none installed. */
function newestRuntime(
  entry: DriverCatalogEntry,
  model: string,
  request: DeviceRequest,
  range: OsRange,
): string {
  const newest = matchingRuntimes(entry, model, request, range).sort(compareVersions).at(-1);
  if (newest === undefined) throw new RuntimeMissingError(request.platform, range.text);
  return newest;
}

/** What a device's OS must satisfy: the range, the exact version named, or any installed runtime. */
function requiredOs(
  entry: DriverCatalogEntry,
  { osVersion }: DeviceRequest,
  range: OsRange | undefined,
): DeviceRequirement["osVersion"] {
  if (range !== undefined) return range;
  return osVersion === undefined
    ? { kind: "installed", versions: entry.runtimes }
    : { kind: "exact", version: osVersion };
}

/** The request's OS range, when its `osVersion` is one rather than an exact version. */
function requestedRange(request: DeviceRequest): OsRange | undefined {
  if (request.osVersion === undefined) return undefined;
  const parsed = parseOsConstraint(request.osVersion);
  return parsed.ok && parsed.constraint.kind === "range" ? parsed.constraint : undefined;
}
