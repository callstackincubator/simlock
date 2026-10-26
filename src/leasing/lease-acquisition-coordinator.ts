import type { EventBus, EventMap } from "../bus/index.js";
import {
  compareVersions,
  type OsRange,
  parseOsConstraint,
  requestedClass,
  satisfies,
} from "../contract/index.js";
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
  fitsPhysical,
  noPhysicalMatch,
  type PhysicalDevice,
  type PhysicalRequest,
  readPhysicalPresence,
  type VirtualDevice,
  type DeviceRequirement,
  type DeviceSpec,
  type VirtualSpec,
  exactRequirement,
  type LeaseGrant,
  type LeaseProgress,
  type LeaseRecord,
  type MaxPerRequester,
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
  type Core,
  type ManagedDeviceLifecycle,
  type ReadyDeviceHandoff,
  toDriverDevice,
  type SerializedDecision,
  stableError,
  type TargetResolution,
  type WaitingDemand,
} from "../core/index.js";
import {
  type AcquisitionPlan,
  type AcquisitionPlanner,
  type PhysicalPlanInput,
  type WaitingReason,
} from "./acquisition-planner.js";
import { emitLeaseRefusal } from "./lease-refusal.js";
import { type LeaseRequestBook } from "./lease-request-book.js";
import { type LeaseLifecycle } from "./lease-lifecycle.js";
import {
  LeaseIdTakenError,
  lineOf,
  type LeaseRequestOptions,
  RequestCancelledError,
  requesterLimitDecision,
  type Waiter,
  type WaitQueue,
} from "./wait-queue.js";

export type { LeaseRequestOptions } from "./wait-queue.js";

export class NoCapacityError extends Error {
  constructor(readonly reason?: WaitingReason) {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

export class ProvisionFailedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ProvisionFailedError";
  }
}

/** why: mapped to `DAEMON_UPDATING`; the message is what a refused agent reads. */
export class DaemonUpdatingError extends Error {
  constructor() {
    super("this daemon is updating and takes no new leases");
    this.name = "DaemonUpdatingError";
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
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
}

export type AcquisitionClaims = Pick<DeviceOperationClaims, "isActive">;
export type AcquisitionQuarantine = Pick<Core["quarantine"], "enterFromStalledTransition">;
export type AcquisitionDecision = Pick<SerializedDecision, "run">;
export type AcquisitionDrivers = Pick<DriverCatalog, "get">;
export type AcquisitionPlannerPort = Pick<AcquisitionPlanner, "plan" | "planPhysical">;
export type AcquisitionQueue = Pick<
  WaitQueue,
  | "create"
  | "cancelAll"
  | "depth"
  | "enqueue"
  | "findPendingWaiter"
  | "pendingPlatforms"
  | "head"
  | "isQueued"
  | "markNew"
  | "markProcessing"
  | "notifyProgress"
  | "pending"
  | "physicalDepth"
  | "reject"
  | "resolve"
>;

export interface LeaseAcquisitionCoordinatorOptions {
  readonly catalog: Pick<CatalogReader, "listCatalog">;
  readonly claims: AcquisitionClaims;
  readonly components: Pick<ComponentInstaller, "install">;
  readonly decisions: AcquisitionDecision;
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
  readonly quarantine: AcquisitionQuarantine;
  readonly registry: LeaseAcquisitionRegistry;
  readonly logger?: Logger;
  readonly requests: Pick<LeaseRequestBook<LeaseGrant>, "admit" | "holdsLeaseId" | "replay">;
  readonly maxPerRequester?: MaxPerRequester;
}

interface AcquisitionWaiter extends Waiter {
  failures: number;
  classOf?: ((model: string) => DeviceClass | undefined) | undefined;
  requirement?: DeviceRequirement | undefined;
  spec?: VirtualSpec;
  timing: LeaseTiming;
}

type GrantingPlanKind = "grant-ready" | "grant-physical" | "boot-shutdown" | "provision";

const GRANT_SOURCE: Readonly<Record<GrantingPlanKind, EventMap["lease.granted"]["source"]>> = {
  "boot-shutdown": "booted",
  "grant-physical": "warm",
  "grant-ready": "warm",
  provision: "provisioned",
};

type OperationPlan = Exclude<
  AcquisitionPlan,
  { readonly kind: "grant-ready" | "grant-physical" | "wait" | "no-capacity" }
>;

class PhysicalUnknownModelError extends UnknownModelError {
  constructor(request: PhysicalRequest) {
    super(request.platform, request.model, request.model === undefined ? request.class : undefined);
    this.message = noPhysicalMatch(request).message;
  }
}

const noTiming: LeaseTiming = {
  estimatedBootMs: 0,
  estimatedProvisionMs: 0,
  estimatedReclaimMs: 0,
  estimatedReadyMs: 0,
};

export class LeaseAcquisitionCoordinator implements AcquisitionMaintenance {
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #driving = new WeakSet<AcquisitionWaiter>();
  #admissionClosed = false;
  // why: apart from #admissionClosed, which also stops the warm pool; an update refuses leases and leaves the pool running.
  #updateHold = false;
  #maintenanceDepth = 0;
  readonly #logger: Logger;

  constructor(private readonly options: LeaseAcquisitionCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-acquisition-coordinator") ?? new NoopLogger();
  }

  get queueDepth(): number {
    return this.options.queue.depth;
  }

  get physicalQueueDepth(): number {
    return this.options.queue.physicalDepth;
  }

  servesDefaultMode(spec: DeviceSpec): boolean {
    if (spec.physical) return false;
    return specMode(spec) === this.defaultMode(spec.platform);
  }

  defaultMode(platform: Platform): DeviceMode {
    return this.options.defaultModes[platform] ?? "full";
  }

  /**
   * Synchronous and not routed through `decisions.run`: `lease.cancel`'s `authorize` hook runs
   * before the handler, so it cannot go through the handler's serialized decision.
   */
  pendingRequestOwner(requesterId: string, platform?: Platform): string | undefined {
    return this.options.queue.findPendingWaiter(requesterId, platform)?.options.ownerId;
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
        if (this.#updateHold) {
          this.#refuseForUpdate(requestId, request, options);
          throw new DaemonUpdatingError();
        }
        if (this.#admissionClosed) {
          emitLeaseRefusal(
            this.options.eventBus,
            {
              requestId,
              requester: options.requesterId,
              requestSpec: request,
              reason: "killed",
              fleetRequestId: options.fleetRequestId,
            },
            "lease-acquisition-coordinator",
          );
          throw new NukeCancelledError();
        }
        this.#refuseIfRequesterAtLimit(request, options, requestId);
        this.#refuseIfLeaseIdTaken(request, options, requestId);
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
            ...(options.fleetRequestId === undefined
              ? {}
              : { fleetRequestId: options.fleetRequestId }),
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

  #refuseIfRequesterAtLimit(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { devices, leases } = this.options.registry.snapshot;
    const held = leases
      .filter((lease) => lease.requesterId === options.requesterId)
      .map((lease) => {
        const platform = devices.find((device) => device.id === lease.deviceId)?.spec.platform;
        return {
          grantedAt: lease.grantedAt,
          id: lease.id,
          ...(platform === undefined ? {} : { platform }),
        };
      });
    const waiting = this.options.queue.pendingPlatforms(options.requesterId);
    // why: a probe's held leases were counted by the gateway, fleet-wide; only its waiting
    // request is checked here (ADR 0023 §2).
    const refusal = requesterLimitDecision({
      held,
      maxPerRequester: this.options.maxPerRequester,
      platform: request.platform,
      probe: options.fleetRequestId !== undefined,
      requesterId: options.requesterId,
      waiting,
    });
    if (refusal === undefined) return;
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "already-leased",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
    throw refusal;
  }

  /**
   * ADR 0020: the one clash check on a host, inside the same admission section as the
   * one-lease-per-requester check and after it. An ID is held by an active lease and by a
   * request still waiting, so a restart, which fails every waiting request, frees it.
   */
  #refuseIfLeaseIdTaken(
    request: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    if (
      !this.options.registry.snapshot.leases.some((lease) => lease.id === leaseId) &&
      !this.options.requests.holdsLeaseId(leaseId)
    ) {
      return;
    }
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "lease-id-taken",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
    throw new LeaseIdTakenError(leaseId);
  }

  /** Closes acquisition admission, settles all demand, and drains driver work. */
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#maintenanceDepth += 1;
      this.#admissionClosed = true;
      for (const waiter of this.options.queue.cancelAll(() => new NukeCancelledError())) {
        emitLeaseRefusal(
          this.options.eventBus,
          {
            requestId: waiter.id,
            requester: waiter.options.requesterId,
            requestSpec: waiter.request,
            reason: "killed",
            fleetRequestId: waiter.options.fleetRequestId,
          },
          "lease-acquisition-coordinator",
        );
      }
    });
    while (this.#activeWorkflows.size > 0) {
      await Promise.allSettled(this.#activeWorkflows);
    }
  }

  async holdForUpdate(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#updateHold = true;
      // why: a request already provisioning is granted (#825 Decisions), so only the ones not yet provisioning, `new` (still resolving its spec) or queued, are refused.
      for (const waiter of this.options.queue.pending() as readonly AcquisitionWaiter[]) {
        if (waiter.state !== "queued" && waiter.state !== "new") continue;
        if (this.options.queue.reject(waiter, new DaemonUpdatingError())) {
          this.#refuseForUpdate(waiter.id, waiter.request, waiter.options);
        }
      }
    });
  }

  // why: every waiter passes `#nextPlan` before a provision starts, in whatever state `markNew` or `#defer` left it, so the update hold refuses here (#825 Decisions).
  #refuseUnderHold(waiter: AcquisitionWaiter): boolean {
    if (!this.#updateHold) return false;
    if (this.options.queue.reject(waiter, new DaemonUpdatingError())) {
      this.#refuseForUpdate(waiter.id, waiter.request, waiter.options);
    }
    return true;
  }

  async releaseUpdateHold(): Promise<void> {
    await this.options.decisions.run(async () => {
      this.#updateHold = false;
    });
  }

  #refuseForUpdate(
    requestId: string,
    request: DeviceRequest,
    options: Pick<LeaseRequestOptions, "requesterId" | "fleetRequestId">,
  ): void {
    emitLeaseRefusal(
      this.options.eventBus,
      {
        requestId,
        requester: options.requesterId,
        requestSpec: request,
        reason: "updating",
        fleetRequestId: options.fleetRequestId,
      },
      "lease-acquisition-coordinator",
    );
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
    if (request.physical === true) {
      await this.#drive(waiter);
      return;
    }
    try {
      const resolved = await this.#resolveSpec(driver, request, options, (progress) =>
        this.options.queue.notifyProgress(waiter, progress),
      );
      waiter.spec = resolved.spec;
      waiter.requirement = resolved.requirement;
      waiter.classOf = resolved.classOf;
    } catch (error: unknown) {
      await this.options.decisions.run(async () => {
        this.#reject(waiter, asError(error), "unresolvable-spec");
      });
      return;
    }

    await this.#drive(waiter);
  }

  async #resolveSpec(
    driver: Driver,
    request: DeviceRequest,
    options: LeaseRequestOptions,
    onProgress: (progress: DownloadingProgress) => void,
  ): Promise<{
    readonly spec: VirtualSpec;
    readonly requirement: DeviceRequirement;
    readonly classOf: ((model: string) => DeviceClass | undefined) | undefined;
  }> {
    // The one place a request with no mode gets the worker's default (ADR 0007 §2).
    const mode = request.mode ?? this.defaultMode(request.platform);
    const range = requestedRange(request);
    const target =
      range === undefined
        ? (this.#exactTarget(request, mode) ?? (await this.#resolveClass(request, mode)))
        : await this.#resolveRanged(request, mode, range);
    // A range was settled against the catalog above, so it never installs (ADR 0015 §5).
    const resolved = await this.#resolveOrInstall(onProgress, driver, target.exact, {
      ...options,
      allowDownload: options.allowDownload === true && range === undefined,
    });
    const spec = checkedSpec(resolved, request, mode);
    return {
      classOf: target.classOf,
      requirement: target.requirement ?? exactRequirement(spec),
      spec,
    };
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
    onProgress: (progress: DownloadingProgress) => void,
    driver: Driver,
    request: ExactDeviceRequest,
    options: LeaseRequestOptions,
  ): Promise<VirtualSpec> {
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
          onProgress(next);
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
   * Only a `queued` waiter is safe to reject: `processing` means device work already claimed it,
   * which `cancelAll` owns tearing down. A physical waiter's only in-flight step is a presence
   * read, so it is cancellable in any live state.
   */
  async cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    return this.options.decisions.run(async () => {
      const waiter = this.options.queue.findPendingWaiter(requesterId, platform) as
        | AcquisitionWaiter
        | undefined;
      if (waiter === undefined) return "not-found";
      if (waiter.state !== "queued" && waiter.request.physical !== true) return "not-cancellable";
      const holdsClaim = waiter.state === "processing";
      this.#reject(waiter, new RequestCancelledError(waiter.id), "cancelled");
      // why: a waiter mid presence read holds a grant claim, and its own wake follows the release.
      if (!holdsClaim) this.#wakeQueue();
      return "cancelled";
    });
  }

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
              spec: waiter.spec,
            },
          ],
    );
  }

  /**
   * Resolves a request to the spec it would be granted a device of, with downloads off, or says
   * why there is none. A read: nothing is queued, reserved or installed. The warm pool resolves
   * its targets here, so a target and a request become a spec in one place.
   */
  async resolve(request: DeviceRequest): Promise<TargetResolution> {
    let driver: Driver;
    try {
      driver = this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      return { message: asError(error).message, refusal: "no-driver" };
    }
    try {
      const { spec } = await this.#resolveSpec(
        driver,
        request,
        { allowDownload: false, ownerId: "warm-pool", requesterId: "warm-pool" },
        () => undefined,
      );
      return { spec };
    } catch (error: unknown) {
      return { message: asError(error).message, refusal: refusalOf(error) };
    }
  }

  get maintenanceActive(): boolean {
    return this.#admissionClosed;
  }

  kick(): void {
    this.#wakeQueue();
  }

  async #drive(waiter: AcquisitionWaiter): Promise<void> {
    if (this.#driving.has(waiter)) return;
    this.#driving.add(waiter);
    try {
      if (waiter.request.physical === true) {
        await this.#drivePhysical(waiter);
        return;
      }
      const action = await this.options.decisions.run(async () => this.#decide(waiter));
      await this.#perform(waiter, action);
    } finally {
      this.#driving.delete(waiter);
    }
  }

  async #drivePhysical(waiter: AcquisitionWaiter): Promise<void> {
    const absent = new Set<string>();
    for (;;) {
      const plan = await this.options.decisions.run(async () =>
        this.#decidePhysical(waiter, absent),
      );
      if (plan === undefined) return;
      if (!(await this.#grantPhysical(waiter, plan, absent))) return;
    }
  }

  #decidePhysical(
    waiter: AcquisitionWaiter,
    absent: ReadonlySet<string>,
  ): Extract<AcquisitionPlan, { readonly kind: "grant-physical" }> | undefined {
    const request = physicalRequestOf(waiter.request);
    const enrolled = this.options.registry.snapshot.devices;
    if (
      !enrolled.some(
        (device) => device.physical && device.state !== "deleted" && fitsPhysical(device, request),
      )
    ) {
      this.#reject(waiter, new PhysicalUnknownModelError(request), "unresolvable-spec");
      return undefined;
    }
    const plan = this.options.planner.planPhysical({
      absent,
      heldByOlder: this.#heldByOlder(waiter),
      noWait: waiter.options.noWait ?? false,
      owner: waiter.id,
      request,
      snapshot: this.options.registry.snapshot,
    });
    if (plan.kind !== "grant-physical") {
      this.#defer(waiter, blockedReason(plan));
      return undefined;
    }
    if (!this.options.queue.markProcessing(waiter)) {
      plan.claim.release();
      return undefined;
    }
    return plan;
  }

  #heldByOlder(waiter: AcquisitionWaiter): PhysicalPlanInput["heldByOlder"] {
    const older: PhysicalRequest[] = [];
    for (const other of this.options.queue.pending()) {
      if (other === waiter) break;
      if (lineOf(other.request) === "physical" && other.state === "queued") {
        older.push(physicalRequestOf(other.request));
      }
    }
    return (device: PhysicalDevice) => older.some((request) => fitsPhysical(device, request));
  }

  async #grantPhysical(
    waiter: AcquisitionWaiter,
    plan: Extract<AcquisitionPlan, { readonly kind: "grant-physical" }>,
    absent: Set<string>,
  ): Promise<boolean> {
    const { claim, device } = plan;
    let present = false;
    try {
      const reads = await readPhysicalPresence(this.options.drivers.get(device.spec.platform), [
        device.driverDeviceId,
      ]);
      present = reads.get(device.driverDeviceId) === true;
    } catch (error: unknown) {
      this.#logFailure(
        "reading a physical device's presence failed",
        waiter,
        device,
        "presence",
        error,
      );
    }
    let replan = false;
    await this.options.decisions.run(async () => {
      try {
        if (!this.options.queue.markProcessing(waiter)) return;
        const current = this.options.registry.snapshot.devices.find(
          (candidate) => candidate.id === device.id,
        );
        if (!present || !this.options.claims.isActive(claim) || current?.state !== "ready") {
          absent.add(device.id);
          replan = true;
          return;
        }
        await this.#grant(waiter, current, plan.kind);
      } catch (error: unknown) {
        this.#logFailure("granting a physical device failed", waiter, device, "grant", error);
        this.#defer(waiter, "no-free-physical");
      } finally {
        claim.release();
      }
    });
    if (!replan) this.#wakeQueue();
    return replan;
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
      waiter.timing = await estimatedBootTiming(
        this.options.drivers.get(action.device.spec.platform),
        action.device,
      );
      await this.#bootShutdown(waiter, action.device, action.capacityReservation, action.claim);
      return;
    }
    if (action.kind === "evict-running") {
      await this.#evictRunning(waiter, action.device, action.claim, action.reason);
      return;
    }
    await this.#evictManaged(waiter, action.device, action.claim, action.reason);
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
        claim: { kind: "boot", owner: waiter.id },
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
        // why: ADR 0021 §1 declines a probe instead of rejecting it, and its caller (the gateway) reads the code.
        this.#reject(
          waiter,
          new ProvisionFailedError(error),
          waiter.options.fleetRequestId === undefined ? "unresolvable-spec" : "no-wait",
        );
        return false;
      });
      if (retry) {
        this.#driving.delete(waiter);
        await this.#drive(waiter);
      } else {
        this.#wakeQueue();
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
      // why: the queue's own rule is that a timeout firing mid-attempt does not reject
      // (`wait-queue.ts`), and it tells an attempt is in flight only from `processing`. Without
      // this mark the waiter is still `queued` while the lease is written, so a timeout that
      // falls due in that window rejects the caller over a lease that is being stored.
      if (!this.options.queue.markProcessing(waiter)) return undefined;
      try {
        await this.#grant(waiter, plan.device, plan.kind);
        // why: the next request in line may already have a ready device waiting for it, and no
        // other event will wake it.
        this.#wakeQueue();
      } catch (error: unknown) {
        this.#logFailure("granting a ready device failed", waiter, plan.device, "grant", error);
        this.#defer(waiter, "waiting-for-device");
      }
      return undefined;
    }
    const operation = operationPlan(plan);
    if (operation === undefined) {
      this.#defer(waiter, blockedReason(plan));
      return undefined;
    }
    // why: a refusal means the queue has just rejected this waiter at its deadline, so the device
    // work this plan stands for would run for a requester who was already answered. The plan holds
    // a capacity reservation or a device claim, so it gives those back here rather than at a
    // performer that will never be reached.
    if (!this.options.queue.markProcessing(waiter)) {
      releasePlanResources(operation);
      return undefined;
    }
    return operation;
  }

  #nextPlan(waiter: AcquisitionWaiter): AcquisitionPlan | undefined {
    if (waiter.state === "rejected" || waiter.state === "granted" || waiter.spec === undefined) {
      return undefined;
    }
    if (this.#refuseUnderHold(waiter)) return undefined;
    const head = this.options.queue.head;
    if (head !== undefined && head !== waiter) {
      const reason = "behind-earlier-request";
      return waiter.options.noWait ? { kind: "no-capacity", reason } : { kind: "wait", reason };
    }
    return this.options.planner.plan({
      noWait: waiter.options.noWait ?? false,
      owner: waiter.id,
      snapshot: this.options.registry.snapshot,
      spec: waiter.spec,
      requirement: waiter.requirement,
      classOf: waiter.classOf,
    });
  }

  async #grant(
    waiter: AcquisitionWaiter,
    device: DeviceRecord,
    kind: GrantingPlanKind,
  ): Promise<void> {
    // Built before the write: the grant a repeat of this request answers is stored with the lease.
    const granted = await this.options.leases.grant({
      deviceId: device.id,
      environment: this.options.drivers
        .get(device.spec.platform)
        .leaseEnvironment(toDriverDevice(device)),
      ownerId: waiter.options.ownerId,
      requestId: waiter.id,
      requesterId: waiter.options.requesterId,
      source: GRANT_SOURCE[kind],
      timing: waiter.timing,
      ...(waiter.options.ttlMs === undefined ? {} : { ttlMs: waiter.options.ttlMs }),
      ...(waiter.options.leaseId === undefined ? {} : { leaseId: waiter.options.leaseId }),
      ...(waiter.options.fleetRequestId === undefined
        ? {}
        : { fleetRequestId: waiter.options.fleetRequestId }),
    });
    this.options.queue.resolve(waiter, granted);
  }

  async #evictRunning(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    claim: DeviceOperationClaim,
    reason: WaitingReason,
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
        this.#defer(waiter, reason);
      });
      return;
    }
    await this.#continueAfterEviction(waiter, claim);
  }

  async #evictManaged(
    waiter: AcquisitionWaiter,
    device: VirtualDevice,
    claim: DeviceOperationClaim,
    reason: WaitingReason,
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
        this.#defer(waiter, reason);
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
    device: VirtualDevice,
    capacityReservation: CapacityReservation,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    let handoff: ReadyDeviceHandoff;
    try {
      this.options.queue.notifyProgress(waiter, {
        stage: "booting",
        etaMs: waiter.timing.estimatedBootMs,
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
        await this.options.lifecycle.destroy(device, "lease-engine", "cleanup");
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
      // why: a device the destroy could not retire may still be running, so it is handed to
      // quarantine before the waiter's reservation is freed: `quarantined` is the one state that
      // retries it, keeps it out of every plan and still counts it as running. Freeing the slot
      // first would leave a window where the next planner boots a device that may be running.
      if (!destroyed) {
        try {
          const quarantined = await this.options.quarantine.enterFromStalledTransition(
            device.id,
            device.state,
          );
          if (!quarantined) {
            this.#logger.warn(
              "a device that failed to be destroyed was not quarantined: something else owns it now",
              { deviceId: device.id, requesterId: waiter.options.requesterId, step: "quarantine" },
            );
          }
        } catch (quarantineError: unknown) {
          this.#logFailure(
            "quarantining a device that failed to boot and to be destroyed failed",
            waiter,
            device,
            "quarantine",
            quarantineError,
          );
        }
      }
      await this.options.decisions.run(async () => {
        capacityReservation.release();
        if (waiter.state !== "rejected") {
          this.#reject(waiter, new BootTimeoutError(device.id), "boot-timeout");
        }
      });
      this.#wakeQueue();
      return;
    }
    await this.#grantHandoff(waiter, handoff, "boot-shutdown", capacityReservation);
  }

  #defer(waiter: AcquisitionWaiter, reason: WaitingReason): void {
    if (waiter.options.noWait) {
      this.#reject(waiter, new NoCapacityError(reason), "no-wait");
      return;
    }
    this.#enqueue(waiter, reason);
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
        await this.#grant(waiter, handoff.device, kind);
      } catch (error: unknown) {
        // why: a grant that failed to store leaves no lease behind (`#commit` mutates memory
        // only after the file write), so the waiter is re-queued for a fresh grant like every
        // sibling step; without this catch the error dies in `#track` and the waiter is never
        // planned again -- no timer, no wake, and its request stays open for the process.
        this.#logFailure(
          kind === "provision"
            ? "granting a provisioned device failed"
            : "granting a booted device failed",
          waiter,
          handoff.device,
          "grant",
          error,
        );
        this.#defer(waiter, "waiting-for-device");
      } finally {
        capacityReservation?.release();
        handoff.claim.release();
      }
    });
    this.#wakeQueue();
  }

  #enqueue(waiter: AcquisitionWaiter, reason: WaitingReason): void {
    const alreadyQueued = this.options.queue.isQueued(waiter);
    if (this.options.queue.enqueue(waiter, reason) && !alreadyQueued) {
      this.options.eventBus.emit(
        "lease.queued",
        {
          queuePosition:
            lineOf(waiter.request) === "physical"
              ? this.options.queue.physicalDepth
              : this.options.queue.depth,
          requestId: waiter.id,
        },
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
      emitLeaseRefusal(
        this.options.eventBus,
        {
          requestId: waiter.id,
          requester: waiter.options.requesterId,
          requestSpec: waiter.request,
          reason,
          fleetRequestId: waiter.options.fleetRequestId,
        },
        "lease-acquisition-coordinator",
      );
    }
  }

  #wakeQueue(): void {
    void this.options.decisions.run(async () => {
      const next = this.options.queue.head as AcquisitionWaiter | undefined;
      if (next !== undefined && next.state === "queued") this.#track(this.#drive(next));
      for (const waiter of this.options.queue.pending() as readonly AcquisitionWaiter[]) {
        if (lineOf(waiter.request) === "physical") {
          this.#track(this.#drive(waiter));
        }
      }
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

async function estimatedBootTiming(driver: Driver, device: DeviceRecord): Promise<LeaseTiming> {
  const spec = device.spec;
  // why: The quote is advisory. A driver that cannot read the device's own boot path (a failed
  // `emulator -version`, say) must not strand the claim and capacity reservation that the boot
  // below releases, so the device-less figure stands in.
  const estimatedBootMs = await Promise.resolve(
    driver.estimate(
      { device: toDriverDevice(device), operation: "boot", purpose: "prepare" },
      spec,
    ),
  ).catch(() => driver.estimate({ operation: "boot" }, spec));
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

/** `standard`: every release path asks for it; a holder cannot request another clean level. */
function releaseReclaimEstimateMs(driver: Driver, spec: DeviceSpec): number {
  return driver.estimate({ clean: "standard", operation: "reclaim" }, spec);
}

/**
 * why: a plan handed out the capacity or device claim its operation needs; dropping the plan has
 * to give it back, or the resource stays held with nobody left to release it.
 */
function releasePlanResources(plan: OperationPlan): void {
  if (plan.kind === "provision") plan.reservation.release();
  else if (plan.kind === "boot-shutdown") {
    plan.capacityReservation.release();
    plan.claim.release();
  } else plan.claim.release();
}

function blockedReason(plan: AcquisitionPlan): WaitingReason {
  return "reason" in plan ? plan.reason : "no-free-physical";
}

function operationPlan(plan: AcquisitionPlan): OperationPlan | undefined {
  return plan.kind === "grant-ready" ||
    plan.kind === "grant-physical" ||
    plan.kind === "wait" ||
    plan.kind === "no-capacity"
    ? undefined
    : plan;
}

function physicalRequestOf(request: DeviceRequest): PhysicalRequest {
  return {
    platform: request.platform,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.class === undefined ? {} : { class: request.class }),
    ...(request.osVersion === undefined ? {} : { osVersion: request.osVersion }),
  };
}

function fullSpec(spec: VirtualSpec): VirtualSpec {
  if (spec.mode === undefined) return spec;
  const { mode: _mode, ...full } = spec;
  return full;
}

type DownloadingProgress = Extract<LeaseProgress, { readonly stage: "downloading" }>;

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
function checkedSpec(resolved: VirtualSpec, request: DeviceRequest, mode: DeviceMode): VirtualSpec {
  if (resolved.imageTag !== request.imageTag) {
    throw new Error(
      `The ${request.platform} driver resolved image tag ${String(resolved.imageTag)} ` +
        `for a request naming ${String(request.imageTag)}`,
    );
  }
  return mode === "slim" ? resolved : fullSpec(resolved);
}

/** What a target's refusal is called: the kinds a pool can act on, and any other as is. */
function refusalOf(error: unknown): Exclude<TargetResolution, { spec: VirtualSpec }>["refusal"] {
  if (error instanceof RuntimeMissingError) return "runtime-missing";
  if (error instanceof UnknownModelError) return "unknown-model";
  return "unresolvable";
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
