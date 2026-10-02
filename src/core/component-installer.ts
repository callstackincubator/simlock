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

/**
 * What a caller hears while its call is open: that it waits behind another install, that its
 * install has started (`downloading` with no `percent`, before the driver reports anything), or
 * the driver's own progress, its `percent` within 0..100 or left out when it was not a number.
 */
export type ComponentInstallerProgress =
  | ComponentInstallProgress
  | { readonly stage: "downloading"; readonly percent?: undefined }
  | { readonly stage: "waiting" };

export interface ComponentInstallRequest {
  readonly platform: Platform;
  /** The string a driver named in `RuntimeMissingError.component`, carried unread. */
  readonly component: string;
  /** Who asked, for the `component.install-*` events of an install this call starts. */
  readonly requesterId?: string;
  /**
   * Run once when the call reaches the front of its platform's queue (ADR 0010 §3). `false`
   * ends the call as `not-needed` with no install: another install made it unnecessary.
   */
  readonly stillNeeded?: () => Promise<boolean>;
  readonly onProgress?: (progress: ComponentInstallerProgress) => void;
  /**
   * Called once, synchronously, when the call is queued or has joined an install: after every
   * refusal `install` makes at the door (no driver for the platform, the installer closed), and
   * before any progress. A transport commits to a streamed response here.
   */
  readonly onAdmitted?: () => void;
}

export interface ComponentInstallOutcome {
  readonly outcome: "installed" | "already-installed" | "not-needed";
  /** The exact version installed or found; absent for `not-needed`. */
  readonly version?: string;
}

export interface ComponentInstallerOptions {
  readonly clock: Clock;
  /**
   * The daemon's one decision gate, shared with the lease engine: every registry write runs
   * inside it, so the installer's record never interleaves with a device or lease commit.
   */
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly diskSpace: Pick<DiskSpaceGuard, "reserve">;
  readonly drivers: Pick<DriverCatalog, "get" | "select">;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Pick<Filesystem, "diskFree">;
  /** Hears a driver whose `listComponents` rejects; `list` leaves that driver out. */
  readonly logger?: Logger;
  readonly registry: Pick<Registry, "deleteComponent" | "recordComponent" | "snapshot">;
  /** `downloads.timeoutMs`: one budget per call, from the moment `install` is called. */
  readonly timeoutMs: number;
}

/**
 * One install `status.get` lists (ADR 0010 §3). `waiting`: queued behind another install on its
 * platform, or at the front checking whether it is still needed and fits on disk. `downloading`:
 * the driver's installer is running, or has returned and its record is being written.
 */
export interface ComponentInstallInProgress {
  readonly platform: Platform;
  /** Carried unread, as the driver named it. */
  readonly component: string;
  readonly state: "waiting" | "downloading";
  /** When the first call for this install arrived. */
  readonly since: number;
  /** How many calls are joined to it. */
  readonly waiters: number;
}

/**
 * One installed component as `list` reports it (ADR 0010 §8). `installedBySimlock` is true only
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
  /** The version as the catalog lists it, which names Simlock's record of installing it. */
  readonly version: string;
  /** Run every check a removal runs, and remove nothing. */
  readonly dryRun?: boolean;
  /** Who asked, for `component.removed` (safety rule 6). */
  readonly requesterId: string;
}

export interface ComponentRemoveOutcome {
  readonly outcome: "removed" | "would-remove";
  /** The component's size as listed, when the driver could read it. */
  readonly sizeBytes?: number;
  /** What stayed on disk after a removal, and how to reclaim it; never on a dry run. */
  readonly residue?: string;
}

/**
 * A device request that resolved to a component being removed (ADR 0010 §8). A
 * `RuntimeMissingError`, so a lease request that hits it is rejected with `RUNTIME_MISSING`.
 */
export class ComponentBeingRemovedError extends RuntimeMissingError {
  constructor(platform: Platform, version: string) {
    super(platform, version);
    this.message = `${platform} ${version} is being removed; no new device is created on it`;
    this.name = "ComponentBeingRemovedError";
  }
}

/** One running removal; see `ComponentInstaller.#removals`. */
interface Removal {
  readonly abort: AbortController;
  readonly version: string;
  marked: boolean;
}

/** `inProgress()` lists at most this many installs, the oldest first. */
const MAX_LISTED_INSTALLS = 16;

/** Every call still open when the daemon stops rejects with this; nothing is resumed. */
export class ComponentInstallerClosedError extends Error {
  constructor(operation: "install" | "removal" = "install") {
    super(`The daemon is stopping; the component ${operation} was ended`);
    this.name = "ComponentInstallerClosedError";
  }
}

/**
 * Where one install is. `waiting`: behind another install on its platform. `front`: at the head
 * of the queue, checking whether it is still needed, already there, and fits on disk. `running`:
 * the driver's installer is running. `recording`: it returned an install, and its record is being
 * written. `ended`: settled or abandoned, so nothing joins it any more
 * -- an install whose calls all timed out stays `ended` at the head until its driver returns.
 */
type InstallState = "waiting" | "front" | "running" | "recording" | "ended";

interface Install {
  readonly platform: Platform;
  readonly component: string;
  /** The requester whose call started this install, when known. */
  readonly requesterId: string | undefined;
  /** The calls still open on it. A call leaves this list exactly when it settles. */
  readonly calls: InstallCall[];
  /** When the call that created it arrived. */
  readonly since: number;
  state: InstallState;
  abort: AbortController | undefined;
  /** The last report its calls heard since it started running, told at once to a call that joins. */
  latest: ComponentInstallerProgress | undefined;
}

interface InstallCall {
  readonly request: ComponentInstallRequest;
  readonly install: Install;
  readonly resolve: (outcome: ComponentInstallOutcome) => void;
  readonly reject: (error: unknown) => void;
  timer: TimerHandle | undefined;
  /** Whether its `stillNeeded` has run (or it has none). */
  checked: boolean;
}

/**
 * The only caller of `Driver.installComponent` (ADR 0010 §3). One queue per platform, first come
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
   * The one record of each running removal (architecture rule 12), by the platform whose turn it
   * holds: while a platform is here no install on it starts (`#pump`). `marked` is set inside the
   * decision gate; from then until the removal leaves this map, on every exit, `claimProvision`
   * refuses every device of `version`. `abort` ends the removal on `close()`.
   */
  readonly #removals = new Map<Platform, Removal>();
  /** Per `componentKey`, the provisions that have claimed it and not yet registered a device. */
  readonly #provisioning = new Map<string, number>();

  readonly #logger: Logger;

  constructor(private readonly options: ComponentInstallerOptions) {
    this.#logger = options.logger ?? new NoopLogger();
  }

  install(request: ComponentInstallRequest): Promise<ComponentInstallOutcome> {
    if (this.#closed) return Promise.reject(new ComponentInstallerClosedError());
    try {
      // A platform with no driver is refused at the door, before the call is admitted.
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
      // One budget per call, measured from its arrival, covering waiting and installing alike
      // (architecture rule 11). Nothing re-arms it.
      call.timer = this.options.clock.setTimer(this.options.timeoutMs, () => {
        this.#expire(call);
      });
      try {
        request.onAdmitted?.();
      } catch {
        // An observer, like `onProgress`: a throw there must not reach the install.
      }
      if (queue[0] !== install || this.#removals.has(request.platform)) {
        notify(call, { stage: "waiting" });
      } else if (install.latest !== undefined) notify(call, install.latest);
      this.#pump(request.platform);
    });
  }

  /**
   * The installs waiting or running, read from the queues themselves (architecture rule 12):
   * the oldest `MAX_LISTED_INSTALLS`, oldest first. An install no call waits on any more is not
   * listed: it has ended for everyone who asked, even while it is still in its queue. That
   * covers an `ended` install too, which never has a call: settling it empties its list, and
   * nothing joins it after.
   */
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

  /**
   * Every installed component on this platform's driver, or on every driver, ordered by
   * platform, then version, then variant. Read-only: it asks each driver's `listComponents` and
   * reads the registry, and writes nothing. A driver whose listing rejects is left out and
   * logged, and the other platforms are still listed.
   */
  // fallow-ignore-next-line unused-class-member -- reached through the Dispatcher's `components` option, typed as a Pick of this class.
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
   * Removes a component Simlock installed (ADR 0010 §8), or with `dryRun` runs every check a
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
    // Checked and taken with no `await` between them, so nothing can start on the platform in
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
      // Every exit, a throw included, clears the mark and gives the turn back.
      this.#runs.delete(settled);
      this.#removals.delete(platform);
      this.#pump(platform);
    }
  }

  /**
   * The checks a removal and a dry run share, from `list` (architecture rule 10): Simlock's
   * record of this version, a listed component whose receipt equals the record's, and no device
   * of Simlock's or a foreign one on it. Answers the receipt to remove and the listed size.
   */
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
    // A record outlives a removal that failed after the driver deleted the component (ADR 0010
    // §5): with no such version on the machine, the refusal must not name one.
    if (!components.some((entry) => entry.listing.version === version)) {
      throw new ComponentNotOwnedError(
        platform,
        `No ${platform} ${version} is installed now, so there is nothing to remove`,
      );
    }
    const listed = components.find((entry) => sameReceipt(entry.receipt, record.receipt));
    if (listed === undefined) {
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
      // Committed before `component.removed` is emitted (events rule 3).
      await this.options.decisions.run(() =>
        this.options.registry.deleteComponent(platform, version),
      );
    } catch (error: unknown) {
      // The driver may have removed it before the failure: who asked and what failed is logged
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
   * Claims a device about to be provisioned on `spec`'s platform and version, and answers the
   * release that ends the claim. Call it inside the decision gate, before the driver creates
   * the device, and release once the device's record is committed or the provision failed. A
   * component being removed refuses it with `ComponentBeingRemovedError`; a claim counts as a
   * Simlock device in `list` and in a removal's checks, so a removal cannot start under a
   * device the registry does not hold yet (ADR 0010 §8).
   */
  // fallow-ignore-next-line unused-class-member -- reached through DeviceProvisioner's `components` option, typed as a Pick of this class.
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

  /**
   * One driver's components, each as `list` reports it and with its receipt. Rejects when the
   * driver's listing does: `list` leaves that driver out, and `remove` refuses.
   */
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

  /**
   * Simlock's own devices of this platform and version: every registry device in any state but
   * `deleted`, and every provision that has claimed one and not registered it yet. The one count
   * `list` reports and a removal refuses on.
   */
  #simlockDevices(platform: Platform, version: string): number {
    const registered = this.options.registry.snapshot.devices.filter(
      (device) =>
        device.state !== "deleted" &&
        device.spec.platform === platform &&
        device.spec.osVersion === version,
    ).length;
    return registered + (this.#provisioning.get(componentKey(platform, version)) ?? 0);
  }

  /**
   * Ends the running installs through their `AbortSignal`, rejects every open call, and resolves
   * once each driver run has returned. Nothing is resumed after a restart.
   */
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

  /** Starts the head of a platform's queue when nothing is running there. */
  #pump(platform: Platform): void {
    // A waiting install whose calls all left still goes to the front, finds none, and ends.
    const front = this.#queue(platform)[0];
    if (front === undefined || front.state !== "waiting" || this.#removals.has(platform)) return;
    front.state = "front";
    const run = this.#run(front).finally(() => {
      this.#runs.delete(run);
    });
    this.#runs.add(run);
  }

  /** Never rejects: every failure settles the calls still open, then the queue moves on. */
  async #run(install: Install): Promise<void> {
    try {
      await this.#checkStillNeeded(install);
      if (install.calls.length === 0) return;
      const driver = this.options.drivers.get(install.platform);
      const found = await driver.findComponent(install.component);
      if (found !== undefined) {
        // Already there: no reservation and no event (ADR 0010 §3).
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

  /** Runs each open call's `stillNeeded` once, including calls that join while it runs. */
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
    // Every call hears that its install started, before the driver reports anything.
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
        // Committed before `component.installed` is emitted (events rule 3).
        const record = {
          installedAt: this.options.clock.now(),
          platform: install.platform,
          receipt: result.receipt,
          version: result.version,
        };
        // The install happened: a call that runs out while the record is written fails alone.
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
    this.#settleAll(install, { outcome: { outcome: result.outcome, version: result.version } });
  }

  /** Tells every call on the install, and keeps the report for a call that joins later. */
  #report(install: Install, progress: ComponentInstallerProgress): void {
    install.latest = progress;
    for (const call of install.calls) notify(call, progress);
  }

  /**
   * A call's budget ran out. A waiting call, or one whose install is only writing its record,
   * leaves alone; the install carries on for the others, or ends when it was the last. A running install is ended at
   * the deadline of the oldest call joined to it -- the first of its timers to fire -- and every
   * call joined to it fails now, not when the driver returns.
   */
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
    // An install left with no calls ends at its next step (`#run`), so the queue moves on.
    this.#settle(call, { error });
  }

  #settleAll(
    install: Install,
    result:
      | { readonly outcome: ComponentInstallOutcome; readonly error?: never }
      | { readonly error: unknown },
  ): void {
    // `#settle` removes each call from the list, so this drains it from the front.
    for (let call = install.calls[0]; call !== undefined; call = install.calls[0]) {
      this.#settle(call, result);
    }
  }

  /** The one exit of a call: leaves its install, stops its timer, fires its promise. */
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

/**
 * The one place a driver's percentage is cleaned for every caller: clamped to 0..100, and left
 * out when it is not a finite number rather than guessed.
 */
function cleanPercent(progress: ComponentInstallProgress): ComponentInstallerProgress {
  if (!Number.isFinite(progress.percent)) return { stage: "downloading" };
  return { percent: Math.min(100, Math.max(0, progress.percent)), stage: "downloading" };
}

/** A caller's progress callback is an observer: a throw there must not reach the install. */
function notify(call: InstallCall, progress: ComponentInstallerProgress): void {
  try {
    call.request.onProgress?.(progress);
  } catch {
    // Isolated like an event handler (events rule 5).
  }
}

/** One component's key in `#provisioning`: its platform and version. */
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

/** By platform, then version (numerically, so `9` precedes `35`), then variant. */
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
