import type { EventBus } from "../bus/index.js";
import {
  type Clock,
  type Filesystem,
  type Logger,
  NoopLogger,
  type TimerHandle,
} from "../ports/index.js";
import type { DeviceSpec, Platform } from "./domain.js";
import {
  ComponentBusyError,
  ComponentInUseError,
  type ComponentInstallProgress,
  type ComponentInstallResult,
  ComponentInstallTimeoutError,
  ComponentNotOwnedError,
  type ComponentReceipt,
  type ComponentRemoval,
  type DiskSpaceGuard,
  type Driver,
  type DriverComponent,
  RuntimeMissingError,
  sameReceipt,
} from "./driver.js";
import type { DriverCatalog } from "./driver-catalog.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export type ComponentInstallerProgress =
  | ComponentInstallProgress
  | { readonly stage: "downloading"; readonly percent?: undefined }
  | { readonly stage: "waiting" };

export interface ComponentInstallRequest {
  readonly platform: Platform;
  readonly component: string;
  readonly requesterId?: string;
  readonly stillNeeded?: () => Promise<boolean>;
  readonly onProgress?: (progress: ComponentInstallerProgress) => void;
  /**
   * why: Called once, synchronously, when the call is queued or has joined an install: after every
   * refusal `install` makes at the door (no driver for the platform, the installer closed), and
   * before any progress. A transport commits to a streamed response here.
   */
  readonly onAdmitted?: () => void;
}

export interface ComponentInstallOutcome {
  readonly outcome: "installed" | "already-installed" | "not-needed";
  readonly version?: string;
}

export interface ComponentInstallerOptions {
  readonly clock: Clock;
  /**
   * why: The daemon's one decision gate, shared with core and leasing: every registry write runs
   * inside it, so the installer's record never interleaves with a device or lease commit.
   */
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly diskSpace: Pick<DiskSpaceGuard, "reserve">;
  readonly drivers: Pick<DriverCatalog, "get" | "select">;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Pick<Filesystem, "diskFree">;
  readonly logger?: Logger;
  readonly registry: Pick<Registry, "deleteComponent" | "recordComponent" | "snapshot">;
  readonly timeoutMs: number;
}

export interface ComponentInstallInProgress {
  readonly platform: Platform;
  readonly component: string;
  readonly state: "waiting" | "downloading";
  readonly since: number;
  readonly waiters: number;
}

/**
 * why: One installed component as `list` reports it (ADR 0010 §8). `installedBySimlock` is true only
 * when a component record's receipt equals this component's: the record is the only proof (§5).
 * `devices` counts Simlock's own devices of this platform and version in any state but
 * `deleted`; the core cannot tell variants apart, so two variants of one version show the same
 * count. `variant` and `foreignDevices` are the driver's, carried unread.
 */
export interface InstalledComponentListing {
  readonly platform: Platform;
  readonly version: string;
  readonly variant?: string;
  readonly sizeBytes?: number;
  readonly installedBySimlock: boolean;
  readonly installedAt?: number;
  readonly devices: number;
  readonly foreignDevices: number;
}

export interface ComponentRemoveRequest {
  readonly platform: Platform;
  readonly version: string;
  readonly dryRun?: boolean;
  readonly requesterId: string;
}

export interface ComponentRemoveOutcome {
  readonly outcome: "removed" | "would-remove";
  readonly sizeBytes?: number;
  readonly residue?: string;
}

export class ComponentBeingRemovedError extends RuntimeMissingError {
  constructor(platform: Platform, version: string) {
    super(platform, version);
    this.message = `${platform} ${version} is being removed; no new device is created on it`;
    this.name = "ComponentBeingRemovedError";
  }
}

interface Removal {
  readonly abort: AbortController;
  readonly version: string;
  marked: boolean;
}

const MAX_LISTED_INSTALLS = 16;

export class ComponentInstallerClosedError extends Error {
  constructor(operation: "install" | "removal" = "install") {
    super(`The daemon is stopping; the component ${operation} was ended`);
    this.name = "ComponentInstallerClosedError";
  }
}

/**
 * why: Where one install is. `waiting`: behind another install on its platform. `front`: at the head
 * of the queue, checking whether it is still needed, already there, and fits on disk. `running`:
 * the driver's installer is running. `recording`: it returned an install, and its record is being
 * written. `ended`: settled or abandoned, so nothing joins it any more
 * -- an install whose calls all timed out stays `ended` at the head until its driver returns.
 */
type InstallState = "waiting" | "front" | "running" | "recording" | "ended";

interface Install {
  readonly platform: Platform;
  readonly component: string;
  readonly requesterId: string | undefined;
  readonly calls: InstallCall[];
  readonly since: number;
  state: InstallState;
  abort: AbortController | undefined;
  latest: ComponentInstallerProgress | undefined;
}

interface InstallCall {
  readonly request: ComponentInstallRequest;
  readonly install: Install;
  readonly resolve: (outcome: ComponentInstallOutcome) => void;
  readonly reject: (error: unknown) => void;
  timer: TimerHandle | undefined;
  checked: boolean;
}

/**
 * why: The only caller of `Driver.installComponent` (ADR 0010 §3). One queue per platform, first come
 * first served; a call for a component that is already waiting or running joins that install.
 * Platforms install independently; the shared `DiskSpaceGuard` is what stops two of them from
 * jointly overfilling a disk.
 *
 * Every call ends in exactly one way: `installed`, `already-installed` or `not-needed`, the
 * install's error, `ComponentInstallTimeoutError` when its budget runs out, or
 * `ComponentInstallerClosedError` on `close()`. Settling removes it from its install, cancels its
 * timer and fires its promise, in one place (`#settle`).
 *
 * Also the only caller of `Driver.removeComponent` (ADR 0010 §8): a removal holds its platform's
 * turn like an install, and `claimProvision` is how device creation learns what is being removed.
 */
export class ComponentInstaller {
  readonly #queues = new Map<Platform, Install[]>();
  readonly #runs = new Set<Promise<void>>();
  #closed = false;
  /**
   * why: The one record of each running removal (architecture rule 12), by the platform whose turn it
   * holds: while a platform is here no install on it starts (`#pump`). `marked` is set inside the
   * decision gate; from then until the removal leaves this map, on every exit, `claimProvision`
   * refuses every device of `version`. `abort` ends the removal on `close()`.
   */
  readonly #removals = new Map<Platform, Removal>();
  readonly #provisioning = new Map<string, number>();

  readonly #logger: Logger;

  constructor(private readonly options: ComponentInstallerOptions) {
    this.#logger = options.logger ?? new NoopLogger();
  }

  install(request: ComponentInstallRequest): Promise<ComponentInstallOutcome> {
    if (this.#closed) return Promise.reject(new ComponentInstallerClosedError());
    try {
      this.options.drivers.get(request.platform);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return new Promise<ComponentInstallOutcome>((resolve, reject) => {
      const queue = this.#queue(request.platform);
      const install = this.#joinable(queue, request.component) ?? this.#enqueue(queue, request);
      const call: InstallCall = {
        checked: false,
        install,
        reject,
        request,
        resolve,
        timer: undefined,
      };
      install.calls.push(call);
      call.timer = this.options.clock.setTimer(this.options.timeoutMs, () => {
        this.#expire(call);
      });
      try {
        request.onAdmitted?.();
      } catch {
        // why: An observer, like `onProgress`: a throw there must not reach the install.
      }
      if (queue[0] !== install || this.#removals.has(request.platform)) {
        notify(call, { stage: "waiting" });
      } else if (install.latest !== undefined) notify(call, install.latest);
      this.#pump(request.platform);
    });
  }

  // fallow-ignore-next-line unused-class-member -- called through core's ports, and by its tests through the test-* harness.
  inProgress(): readonly ComponentInstallInProgress[] {
    const listed: ComponentInstallInProgress[] = [];
    for (const queue of this.#queues.values()) {
      for (const install of queue) {
        if (install.calls.length === 0) continue;
        listed.push({
          component: install.component,
          platform: install.platform,
          since: install.since,
          state:
            install.state === "running" || install.state === "recording"
              ? "downloading"
              : "waiting",
          waiters: install.calls.length,
        });
      }
    }
    return listed.sort((a, b) => a.since - b.since).slice(0, MAX_LISTED_INSTALLS);
  }

  async list(platform?: Platform): Promise<readonly InstalledComponentListing[]> {
    const listed = await Promise.all(
      this.options.drivers.select(platform).map(async (driver) => {
        try {
          return await this.#listDriver(driver);
        } catch (error: unknown) {
          this.#logger.warn("A driver could not list its installed components", {
            error: stableError(error),
            platform: driver.platform,
          });
          return [];
        }
      }),
    );
    return listed
      .flat()
      .map(({ listing }) => listing)
      .sort(compareListings);
  }

  /**
   * why: Removes a component Simlock installed (ADR 0010 §8), or with `dryRun` runs every check a
   * removal runs and stops. Refused, before anything changes, with `ComponentNotOwnedError` when
   * Simlock has no record of it or what is installed now is not what the record names,
   * `ComponentInUseError` when `list` counts a device of Simlock's or a foreign one on it, and
   * `ComponentBusyError` while an install or another removal is running or waiting on the
   * platform. A listing that rejects rejects the removal: an unreadable count is never "no users".
   *
   * A removal holds the platform's turn, so an install that arrives waits behind it. Inside the
   * decision gate it counts Simlock's devices again and marks the component as being removed;
   * from then until it settles `claimProvision` refuses every device on it. The driver removes
   * it; then the record is deleted and `component.removed` emitted. A failure is logged, keeps
   * the record, and rethrows. Every exit clears the mark and gives the turn back.
   */
  async remove(request: ComponentRemoveRequest): Promise<ComponentRemoveOutcome> {
    if (this.#closed) throw new ComponentInstallerClosedError("removal");
    const { platform, version } = request;
    const driver = this.options.drivers.get(platform);
    const { receipt, sizeBytes } = await this.#removable(driver, version);
    if (this.#closed) throw new ComponentInstallerClosedError("removal");
    // why: Checked and taken with no `await` between them, so nothing can start on the platform in
    // between. `#removals` is the one record of the turn (architecture rule 12).
    if (this.#queue(platform).length > 0 || this.#removals.has(platform)) {
      throw new ComponentBusyError(platform, version);
    }
    if (request.dryRun === true) {
      return { outcome: "would-remove", ...(sizeBytes === undefined ? {} : { sizeBytes }) };
    }

    const removal: Removal = { abort: new AbortController(), marked: false, version };
    this.#removals.set(platform, removal);
    const run = this.#removeHoldingTurn(driver, request, receipt, removal);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#runs.add(settled);
    try {
      return await run;
    } finally {
      this.#runs.delete(settled);
      this.#removals.delete(platform);
      this.#pump(platform);
    }
  }

  async #removable(
    driver: Driver,
    version: string,
  ): Promise<{ readonly receipt: ComponentReceipt; readonly sizeBytes?: number }> {
    const { platform } = driver;
    const record = this.options.registry.snapshot.components.find(
      (candidate) => candidate.platform === platform && candidate.version === version,
    );
    if (record === undefined) {
      throw new ComponentNotOwnedError(
        platform,
        `Simlock has no record of installing ${platform} ${version}, so it will not remove it`,
      );
    }
    const components = await this.#listDriver(driver);
    const listed = components.find((entry) => sameReceipt(entry.receipt, record.receipt));
    if (listed === undefined) {
      // why: A record outlives a removal that failed after the driver deleted the component (ADR 0010
      // §5): with no such version on the machine, the refusal must not name one.
      if (!components.some((entry) => entry.listing.version === version)) {
        throw new ComponentNotOwnedError(
          platform,
          `No ${platform} ${version} is installed now, so there is nothing to remove`,
        );
      }
      throw new ComponentNotOwnedError(
        platform,
        `The ${platform} ${version} installed now is not the one Simlock installed, so Simlock ` +
          "will not remove it",
      );
    }
    const { devices, foreignDevices, sizeBytes } = listed.listing;
    if (devices > 0 || foreignDevices > 0) {
      throw new ComponentInUseError(platform, version, { devices, foreignDevices });
    }
    return { receipt: record.receipt, ...(sizeBytes === undefined ? {} : { sizeBytes }) };
  }

  async #removeHoldingTurn(
    driver: Driver,
    request: ComponentRemoveRequest,
    receipt: ComponentReceipt,
    removal: Removal,
  ): Promise<ComponentRemoveOutcome> {
    const { signal } = removal.abort;
    const { platform, version } = request;
    await this.options.decisions.run(() => {
      const devices = this.#simlockDevices(platform, version);
      if (devices > 0) {
        throw new ComponentInUseError(platform, version, { devices, foreignDevices: 0 });
      }
      removal.marked = true;
    });
    let removed: ComponentRemoval;
    try {
      removed = await driver.removeComponent(receipt, { signal });
      // why: Committed before `component.removed` is emitted (events rule 3).
      await this.options.decisions.run(() =>
        this.options.registry.deleteComponent(platform, version),
      );
    } catch (error: unknown) {
      // why: The driver may have removed it before the failure: who asked and what failed is logged
      // (safety rule 6), and the record stands, claiming nothing once its receipt is gone.
      this.#logger.warn("A component removal failed; Simlock's record of it is kept", {
        error: stableError(error),
        platform,
        requesterId: request.requesterId,
        version,
      });
      if (signal.aborted) throw new ComponentInstallerClosedError("removal");
      throw error;
    }
    const outcome = {
      ...(removed.sizeBytes === undefined ? {} : { sizeBytes: removed.sizeBytes }),
      ...(removed.residue === undefined ? {} : { residue: removed.residue }),
    };
    this.options.eventBus.emit(
      "component.removed",
      { componentId: version, platform, requesterId: request.requesterId, version, ...outcome },
      "component-installer",
    );
    return { outcome: "removed", ...outcome };
  }

  /**
   * why: Claims a device about to be provisioned on `spec`'s platform and version, and answers the
   * release that ends the claim. Call it inside the decision gate, before the driver creates
   * the device, and release once the device's record is committed or the provision failed. A
   * component being removed refuses it with `ComponentBeingRemovedError`; a claim counts as a
   * Simlock device in `list` and in a removal's checks, so a removal cannot start under a
   * device the registry does not hold yet (ADR 0010 §8).
   */
  // fallow-ignore-next-line unused-class-member -- called through core's ports, and by its tests through the test-* harness.
  claimProvision(spec: Pick<DeviceSpec, "osVersion" | "platform">): () => void {
    const key = componentKey(spec.platform, spec.osVersion);
    const removal = this.#removals.get(spec.platform);
    if (removal?.marked === true && removal.version === spec.osVersion) {
      throw new ComponentBeingRemovedError(spec.platform, spec.osVersion);
    }
    this.#provisioning.set(key, (this.#provisioning.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#provisioning.get(key) ?? 0) - 1;
      if (remaining > 0) this.#provisioning.set(key, remaining);
      else this.#provisioning.delete(key);
    };
  }

  async #listDriver(
    driver: Driver,
  ): Promise<
    { readonly listing: InstalledComponentListing; readonly receipt: ComponentReceipt }[]
  > {
    const components = await driver.listComponents();
    const records = this.options.registry.snapshot.components;
    return components.map((component) => {
      const record = records.find(
        (candidate) =>
          candidate.platform === driver.platform &&
          sameReceipt(candidate.receipt, component.receipt),
      );
      return {
        listing: {
          devices: this.#simlockDevices(driver.platform, component.version),
          foreignDevices: component.foreignDevices,
          installedBySimlock: record !== undefined,
          platform: driver.platform,
          version: component.version,
          ...(record === undefined ? {} : { installedAt: record.installedAt }),
          ...optionalFields(component),
        },
        receipt: component.receipt,
      };
    });
  }

  #simlockDevices(platform: Platform, version: string): number {
    const registered = this.options.registry.snapshot.virtualDevices.filter(
      (device) =>
        device.state !== "deleted" &&
        device.spec.platform === platform &&
        device.spec.osVersion === version,
    ).length;
    return registered + (this.#provisioning.get(componentKey(platform, version)) ?? 0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const removal of this.#removals.values()) removal.abort.abort();
    const error = new ComponentInstallerClosedError();
    for (const queue of this.#queues.values()) {
      for (const install of queue) {
        install.abort?.abort(error);
        this.#settleAll(install, { error });
      }
    }
    await Promise.allSettled(this.#runs);
  }

  #queue(platform: Platform): Install[] {
    let queue = this.#queues.get(platform);
    if (queue === undefined) {
      queue = [];
      this.#queues.set(platform, queue);
    }
    return queue;
  }

  #joinable(queue: readonly Install[], component: string): Install | undefined {
    return queue.find((install) => install.component === component && install.state !== "ended");
  }

  #enqueue(queue: Install[], request: ComponentInstallRequest): Install {
    const install: Install = {
      abort: undefined,
      calls: [],
      latest: undefined,
      component: request.component,
      platform: request.platform,
      requesterId: request.requesterId,
      since: this.options.clock.now(),
      state: "waiting",
    };
    queue.push(install);
    return install;
  }

  #pump(platform: Platform): void {
    const front = this.#queue(platform)[0];
    if (front === undefined || front.state !== "waiting" || this.#removals.has(platform)) return;
    front.state = "front";
    const run = this.#run(front).finally(() => {
      this.#runs.delete(run);
    });
    this.#runs.add(run);
  }

  async #run(install: Install): Promise<void> {
    try {
      await this.#checkStillNeeded(install);
      if (install.calls.length === 0) return;
      const driver = this.options.drivers.get(install.platform);
      const found = await driver.findComponent(install.component);
      if (found !== undefined) {
        this.#settleAll(install, {
          outcome: { outcome: "already-installed", version: found.version },
        });
        return;
      }
      if (install.calls.length === 0) return;
      const { bytes, path } = driver.componentFootprint;
      const release = await this.options.diskSpace.reserve(
        this.options.filesystem,
        install.platform,
        bytes,
        path,
      );
      try {
        if (install.calls.length === 0) return;
        await this.#runDriver(install, driver);
      } finally {
        release();
      }
    } catch (error: unknown) {
      this.#settleAll(install, { error });
    } finally {
      install.state = "ended";
      const queue = this.#queue(install.platform);
      const index = queue.indexOf(install);
      if (index !== -1) queue.splice(index, 1);
      this.#pump(install.platform);
    }
  }

  async #checkStillNeeded(install: Install): Promise<void> {
    for (;;) {
      const call = install.calls.find((candidate) => !candidate.checked);
      if (call === undefined) return;
      call.checked = true;
      const stillNeeded = call.request.stillNeeded;
      if (stillNeeded === undefined) continue;
      try {
        if (!(await stillNeeded())) this.#settle(call, { outcome: { outcome: "not-needed" } });
      } catch (error: unknown) {
        this.#settle(call, { error });
      }
    }
  }

  async #runDriver(install: Install, driver: Driver): Promise<void> {
    const abort = new AbortController();
    install.abort = abort;
    install.state = "running";
    this.#report(install, { stage: "downloading" });
    const startedAt = this.options.clock.now();
    const attribution =
      install.requesterId === undefined ? {} : { requesterId: install.requesterId };
    this.options.eventBus.emit(
      "component.install-started",
      { componentId: install.component, platform: install.platform, ...attribution },
      "component-installer",
    );
    let result: ComponentInstallResult;
    try {
      result = await driver.installComponent(install.component, {
        onProgress: (progress) => {
          this.#report(install, cleanPercent(progress));
        },
        signal: abort.signal,
      });
      if (result.outcome === "installed") {
        // why: Committed before `component.installed` is emitted (events rule 3).
        const record = {
          installedAt: this.options.clock.now(),
          platform: install.platform,
          receipt: result.receipt,
          version: result.version,
        };
        // why: The install happened: a call that runs out while the record is written fails alone.
        if (install.state === "running") install.state = "recording";
        await this.options.decisions.run(() => this.options.registry.recordComponent(record));
      }
    } catch (error: unknown) {
      this.options.eventBus.emit(
        "component.install-failed",
        {
          componentId: install.component,
          durationMs: this.options.clock.now() - startedAt,
          error: stableError(error),
          platform: install.platform,
          ...attribution,
        },
        "component-installer",
      );
      throw error;
    }
    this.options.eventBus.emit(
      "component.installed",
      {
        alreadyPresent: result.outcome === "already-installed",
        componentId: install.component,
        durationMs: this.options.clock.now() - startedAt,
        platform: install.platform,
        version: result.version,
        ...attribution,
      },
      "component-installer",
    );
    if (result.outcome === "installed") this.#reportComplete(install);
    this.#settleAll(install, { outcome: { outcome: result.outcome, version: result.version } });
  }

  /**
   * why: Reports 100 for an install that succeeded, unless its last report already was. A driver's
   * last report can stop short of it (an iOS download ends near 99%, then goes quiet until the
   * runtime is mounted), so every platform's install ends at 100 before it settles.
   */
  #reportComplete(install: Install): void {
    const last = install.latest;
    if (last?.stage === "downloading" && last.percent === 100) return;
    this.#report(install, { percent: 100, stage: "downloading" });
  }

  #report(install: Install, progress: ComponentInstallerProgress): void {
    install.latest = progress;
    for (const call of install.calls) notify(call, progress);
  }

  #expire(call: InstallCall): void {
    const { install } = call;
    const error = new ComponentInstallTimeoutError(
      install.platform,
      install.component,
      this.options.timeoutMs,
    );
    if (install.state === "running") {
      install.state = "ended";
      install.abort?.abort(error);
      this.#settleAll(install, { error });
      return;
    }
    this.#settle(call, { error });
  }

  #settleAll(
    install: Install,
    result:
      | { readonly outcome: ComponentInstallOutcome; readonly error?: never }
      | { readonly error: unknown },
  ): void {
    for (let call = install.calls[0]; call !== undefined; call = install.calls[0]) {
      this.#settle(call, result);
    }
  }

  #settle(
    call: InstallCall,
    result:
      | { readonly outcome: ComponentInstallOutcome; readonly error?: never }
      | { readonly error: unknown },
  ): void {
    const index = call.install.calls.indexOf(call);
    if (index === -1) return;
    call.install.calls.splice(index, 1);
    if (call.timer !== undefined) this.options.clock.cancel(call.timer);
    if ("outcome" in result && result.outcome !== undefined) call.resolve(result.outcome);
    else call.reject(result.error);
  }
}

function cleanPercent(progress: ComponentInstallProgress): ComponentInstallerProgress {
  if (!Number.isFinite(progress.percent)) return { stage: "downloading" };
  return { percent: Math.min(100, Math.max(0, progress.percent)), stage: "downloading" };
}

/** why: A caller's progress callback is an observer: a throw there must not reach the install. */
function notify(call: InstallCall, progress: ComponentInstallerProgress): void {
  try {
    call.request.onProgress?.(progress);
  } catch {}
}

function componentKey(platform: Platform, version: string): string {
  return JSON.stringify([platform, version]);
}

function optionalFields(
  component: DriverComponent,
): Pick<InstalledComponentListing, "variant" | "sizeBytes"> {
  return {
    ...(component.variant === undefined ? {} : { variant: component.variant }),
    ...(component.sizeBytes === undefined ? {} : { sizeBytes: component.sizeBytes }),
  };
}

const ORDER = new Intl.Collator("en", { numeric: true });

function compareListings(
  left: InstalledComponentListing,
  right: InstalledComponentListing,
): number {
  return (
    ORDER.compare(left.platform, right.platform) ||
    ORDER.compare(left.version, right.version) ||
    ORDER.compare(left.variant ?? "", right.variant ?? "")
  );
}
