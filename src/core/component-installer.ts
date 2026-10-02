import type { EventBus } from "../bus/index.js";
import type { Clock, Filesystem, TimerHandle } from "../ports/index.js";
import type { Platform } from "./domain.js";
import {
  type ComponentInstallProgress,
  type ComponentInstallResult,
  ComponentInstallTimeoutError,
  type DiskSpaceGuard,
  type Driver,
} from "./driver.js";
import type { DriverCatalog } from "./driver-catalog.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

/** What a caller hears while its call is open: the driver's own progress, or that it waits. */
export type ComponentInstallerProgress = ComponentInstallProgress | { readonly stage: "waiting" };

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
  readonly drivers: Pick<DriverCatalog, "get">;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly filesystem: Pick<Filesystem, "diskFree">;
  readonly registry: Pick<Registry, "recordComponent">;
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

/** `inProgress()` lists at most this many installs, the oldest first. */
const MAX_LISTED_INSTALLS = 16;

/** Every call still open when the daemon stops rejects with this; nothing is resumed. */
export class ComponentInstallerClosedError extends Error {
  constructor() {
    super("The daemon is stopping; the component install was ended");
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
 */
export class ComponentInstaller {
  readonly #queues = new Map<Platform, Install[]>();
  readonly #runs = new Set<Promise<void>>();
  #closed = false;

  constructor(private readonly options: ComponentInstallerOptions) {}

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
      if (queue[0] !== install) notify(call, { stage: "waiting" });
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
   * Ends the running installs through their `AbortSignal`, rejects every open call, and resolves
   * once each driver run has returned. Nothing is resumed after a restart.
   */
  async close(): Promise<void> {
    this.#closed = true;
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
    if (front === undefined || front.state !== "waiting") return;
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
          for (const call of install.calls) notify(call, progress);
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

/** A caller's progress callback is an observer: a throw there must not reach the install. */
function notify(call: InstallCall, progress: ComponentInstallerProgress): void {
  try {
    call.request.onProgress?.(progress);
  } catch {
    // Isolated like an event handler (events rule 5).
  }
}
