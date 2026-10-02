import { z } from "zod";

import type { EventBus, EventHistory } from "../bus/index.js";
import {
  type CleanupReaper,
  ComponentInUseError,
  type ComponentInstaller,
  type ComponentInstallerProgress,
  type Config,
  type DeviceRecord,
  type DeviceRequest,
  type Doctor,
  type HostFacts,
  type Nuke,
  type Registry,
  effectiveAllowDownload,
  RuntimeMissingError,
  transitionEnteredAt,
  UnknownLeaseError,
} from "../core/index.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseCommands,
  PassthroughResolver,
  QueueControl,
} from "../core/lease-ports.js";
import type {
  Clock,
  Logger,
  ProcessRunner,
  StreamingProcessHandle,
  TimerHandle,
} from "../ports/index.js";
import { exitCodeOf, NoopLogger } from "../ports/index.js";
import {
  consoleUrlField,
  fitPlatformCatalog,
  OPERATIONS,
  requestedDevice,
  type ComponentProgress,
  type OperationName,
  WORKER_VIEW_CATALOG_EVENTS,
  WORKER_VIEW_REFRESH_INTERVAL_MS,
  workerViewFields,
} from "../contract/index.js";
import type { TokenStore } from "../http/token-store.js";
import {
  DispatchError,
  runDispatch,
  type DispatchSession,
  type ErasedHandler,
} from "./dispatch.js";

export { DispatchError, type ContractDispatcher, type DispatchSession } from "./dispatch.js";

/*
 * `DispatchSession`, `DispatchError`, and `ContractDispatcher` moved to `./dispatch.js` when
 * ADR 0005 gave the contract a second dispatcher implementation (`src/gateway/`), which needs
 * them without importing this file's `src/core` dependencies. They are re-exported above, so
 * every existing `from "./dispatcher.js"` import keeps working.
 */
/**
 * How long a timed-out `device.exec` child gets between SIGTERM and SIGKILL (ADR 0005 §19e).
 * Fixed rather than derived from `exec.timeoutMs`: it is a termination-cleanup budget, not a
 * fraction of the command's own allowance -- the same reasoning, and the same ten seconds, as
 * `NodeProcessRunner`'s `SIGTERM_TO_SIGKILL_GRACE_MS`.
 */
const EXEC_SIGKILL_GRACE_MS = 10_000;

/** The `Promise.race` marker for "the timeout won". A unique object rather than a string, so
 * it can never collide with something a `StreamingProcessHandle` could resolve with. */
const EXEC_EXPIRED = Symbol("exec-expired");

export class DoctorUnavailableError extends Error {
  constructor() {
    super("Doctor is unavailable");
    this.name = "DoctorUnavailableError";
  }
}

export class NukeUnavailableError extends Error {
  constructor() {
    super("Nuke is unavailable");
    this.name = "NukeUnavailableError";
  }
}

export interface DispatcherOptions {
  readonly capacity: CapacityReader;
  readonly catalog: CatalogReader;
  readonly clock: Clock;
  /**
   * The one installer (ADR 0010 §3), shared with the lease path so `component.install` and a
   * lease request's download join one install, and read for `status.get`'s installs in progress
   * and for `component.list`. `component.remove` goes through it too (ADR 0010 §8).
   */
  readonly components: Pick<ComponentInstaller, "install" | "inProgress" | "list" | "remove">;
  readonly config: Config;
  readonly doctor?: Doctor;
  /** Answers `events.replay`: the ring, or the event file for a `sinceTs`. */
  readonly eventHistory: Pick<EventHistory, "replay">;
  readonly leases: LeaseCommands;
  readonly logger?: Logger;
  /** Classifies a thrown error for the `operation` log line (`classifyError` in production).
   * Injected because `error-code.ts` imports this module. Unset or `undefined`: `INTERNAL`. */
  readonly errorCode?: (error: unknown) => string | undefined;
  readonly nuke?: Nuke;
  /**
   * Builds the scoped command behind `simlock simctl` / `simlock adb` (ADR 0001, decision 7).
   * Optional for the same reason as `nuke`/`doctor`: the many tests that never issue a
   * passthrough should not have to fabricate a resolver.
   */
  readonly passthrough?: PassthroughResolver;
  /**
   * Runs the command `device.exec` resolves (ADR 0005 §19a). Optional for the same reason as
   * `passthrough`: the many tests that never exec should not have to fabricate a runner --
   * `#deviceExec` answers `INTERNAL` when it is missing rather than crashing.
   */
  readonly processRunner?: ProcessRunner;
  /**
   * The environment a `device.exec` child starts from, before the driver's own scoping keys are
   * layered on top. Injected rather than read from `process.env` here (architecture rule 9),
   * and layered rather than replaced because `ProcessRunner` replaces a child's environment
   * wholesale: a child given only `--set`/`-P` scoping would lose `PATH` and never find the
   * tool it was pointed at.
   */
  readonly execEnv?: NodeJS.ProcessEnv;
  readonly queue: QueueControl;
  readonly reaper: CleanupReaper;
  readonly registry: Registry;
  /**
   * ADR 0003 §11: "token create|list|revoke become daemon operations. The daemon is the only
   * owner of tokens.json." Optional so tests that don't exercise `token.*` (the overwhelming
   * majority) don't need to fabricate one -- `#tokenCreate`/`#tokenList`/`#tokenRevoke` throw a
   * clear `DispatchError` when it is missing rather than crashing on `undefined.create(...)`.
   */
  readonly tokens?: TokenStore;
  /** Reports current daemon health for `status.get`. */
  readonly health: () => "starting" | "running" | "failed";
  /** `status.get`'s host block, from memory: answering never waits for a read (ADR 0008 §7). */
  readonly hostFacts: () => HostFacts;
  /**
   * ADR §2 step 4: every operation but `status.get` parks here before its handler runs.
   * `hello` never reaches `dispatch()` at all -- it is answered before a `Session` exists,
   * since the session's `role` is itself resolved from `hello`'s payload (see `session.ts`).
   */
  readonly awaitReady: () => Promise<void>;
  /** This daemon's instance id (`instance.json`), the id it presents to a gateway. `worker.list`
   * answers with it as the one worker's id (ADR 0012 §1). */
  readonly instanceId: string;
  /** This daemon's own version, the one its `hello` reply carries; `worker.list`'s `version`. */
  readonly version: string;
  /**
   * Where `worker.list` hears `WORKER_VIEW_CATALOG_EVENTS`, so its kept catalog is read again at
   * once rather than on its next interval. Optional for the tests that never call `worker.list`;
   * without it the kept catalog is only re-read on the interval.
   */
  readonly eventBus?: Pick<EventBus, "subscribe">;
}

/**
 * A handler's declared *input* type is tied to its operation's contract schema (real
 * type-checking value: a handler that reads `input.wrongField` fails to compile). Its return
 * type is deliberately left as `unknown` rather than `z.infer<...Output>`: core's domain types
 * (`LeaseRecord`, `DoctorReport`, ...) are hand-mirrored by the contract's schemas, not reused
 * (see `schemas.ts`'s module comment -- keeping private types off the public surface is the
 * whole point), so they are not always structurally identical to what `z.infer` produces
 * (`readonly` vs. mutable arrays, in particular). `dispatch()`'s `#parseOutput` is what actually
 * enforces the contract at the boundary, exactly as it did before this PR when handlers lived
 * in `DaemonServer` and returned `unknown` too -- this is not a new gap, just a preserved one.
 */
type Handler<Op extends OperationName> = (
  input: z.infer<(typeof OPERATIONS)[Op]["input"]>,
  session: DispatchSession,
) => Promise<unknown> | unknown;

/** Every operation this (worker-mode) dispatcher implements: the contract's set minus
 * `daemon.stop` (intercepted by `DaemonServer` itself, ADR 0003 §6). */
type WorkerOperationName = Exclude<OperationName, "daemon.stop">;

/**
 * The transport-independent dispatcher (ADR 0003 §2). One `dispatch()` call does, in order:
 * parse input, role check, `authorize` hook, park on startup readiness, call handler, parse
 * output. Handlers never see a raw payload or run their own role/ownership check -- both
 * already happened by the time a handler's function body runs.
 *
 * Deliberately excludes `hello` (protocol-level, answered before a session exists) and
 * `daemon.stop` (ADR §6's frozen exception -- scoped to the protocol-version gate only, so it
 * stays reachable across a version mismatch; still requires a completed handshake and the
 * `admin` role, checked in `DaemonServer#dispatchLine` itself) -- both stay in `DaemonServer`,
 * same as before this PR.
 */
export class Dispatcher {
  readonly #logger: Logger;
  readonly #dispatchLogger: Logger;
  /**
   * Total over every operation but `daemon.stop`. Deliberately *not* a partial map: a declared
   * operation whose handler was never written is otherwise invisible to the compiler and only
   * shows up as `UNKNOWN_REQUEST` at runtime -- which is exactly how `driver.passthrough` came
   * to be declared, dispatched, and unimplemented at once.
   *
   * ADR 0012: a worker answers the fleet operations as a fleet of one. `worker.list` returns
   * this host as its only worker; the operations that act on a gateway's workers refuse with
   * `UNSUPPORTED_IN_WORKER_MODE`, so adding a gateway operation still makes the compiler ask
   * what a worker answers.
   */
  readonly #handlers: Record<WorkerOperationName, ErasedHandler>;
  /**
   * `worker.list`'s catalog: the last `catalog.get` answer and when it was read. Kept for
   * `WORKER_VIEW_REFRESH_INTERVAL_MS`, the rhythm a gateway re-reads a worker's catalog at, and
   * dropped on `WORKER_VIEW_CATALOG_EVENTS`, the events a gateway re-reads it on. Without it
   * every `worker.list` runs each driver's catalog read (`simctl list` on iOS), and the console
   * polls that route every second. Holds the promise, so calls that arrive while a read runs
   * share it; a read that fails is dropped, so the next call reads again.
   */
  #viewCatalog: { readonly readAt: number; readonly catalog: Promise<unknown> } | undefined;
  /** Ends the bus subscriptions that drop `#viewCatalog`; see `dispose`. */
  readonly #unsubscribe: (() => void)[] = [];

  constructor(private readonly options: DispatcherOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    // Observers only (architecture rule 5): dropping a kept read decides nothing.
    for (const event of WORKER_VIEW_CATALOG_EVENTS) {
      const unsubscribe = options.eventBus?.subscribe(event, () => {
        this.#viewCatalog = undefined;
      });
      if (unsubscribe !== undefined) this.#unsubscribe.push(unsubscribe);
    }
    this.#dispatchLogger = this.#logger.child("dispatch");
    this.#handlers = {
      "catalog.get": this.#catalogGet,
      "status.get": this.#statusGet,
      "lease.request": this.#leaseRequest,
      "lease.cancel": this.#leaseCancel,
      "lease.renew": this.#leaseRenew,
      "lease.release": this.#leaseRelease,
      "lease.list": this.#leaseList,
      "driver.passthrough": this.#driverPassthrough,
      "device.exec": this.#deviceExec,
      "doctor.run": this.#doctorRun,
      "lease.release-all": this.#leaseReleaseAll,
      "list.get": this.#listGet,
      "cleanup.run": this.#cleanupRun,
      "nuke.run": this.#nukeRun,
      "config.get": this.#configGet,
      "events.replay": this.#eventsReplay,
      "events.subscribe": this.#eventsSubscribe,
      "events.unsubscribe": this.#eventsUnsubscribe,
      "token.create": this.#tokenCreate,
      "token.list": this.#tokenList,
      "token.revoke": this.#tokenRevoke,
      "component.install": this.#componentInstall,
      "component.list": this.#componentList,
      "component.remove": this.#componentRemove,
      "worker.list": this.#workerList,
      "worker.drain": unsupportedOnWorker("worker.drain"),
      "worker.undrain": unsupportedOnWorker("worker.undrain"),
      "worker.remove": unsupportedOnWorker("worker.remove"),
      "worker.install-component": unsupportedOnWorker(
        "worker.install-component",
        "worker.install-component installs on a gateway's workers, and this daemon is not a gateway; install on this host without naming workers",
      ),
      // "daemon.stop" deliberately absent -- see the class comment; `DaemonServer` never calls
      // `dispatch()` for a frame type this map has no entry for.
    };
  }

  /** Ends this dispatcher's bus subscriptions. `DaemonServer` calls it when the daemon stops. */
  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#viewCatalog = undefined;
  }

  /** ADR 0003 §2's pipeline, run by the shared `runDispatch` (see `./dispatch.js`) over this
   * dispatcher's own handlers, lease lookups, and startup gate. The ordering and the checks
   * are the contract's; only the three inputs below are this implementation's. */
  dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    return runDispatch(operation, rawInput, session, {
      handlers: this.#handlers,
      authorizeLookups: {
        ownerId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.ownerId,
        leaseRequesterId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.requesterId,
        pendingRequestOwner: (requesterId) => this.options.queue.pendingRequestOwner(requesterId),
      },
      awaitReady: () => this.options.awaitReady(),
      onOutputMismatch: (operationName, issues) => {
        this.#logger.error("Operation output failed contract validation", {
          operation: operationName,
          issues,
        });
      },
      observe: {
        clock: this.options.clock,
        logger: this.#dispatchLogger,
        codeOf: (error) => this.options.errorCode?.(error) ?? "INTERNAL",
      },
    });
  }

  // ---- handlers ---------------------------------------------------------------------------
  // Arrow-function class fields (not methods): each closes over `this` so it can be stored in
  // `#handlers` and invoked as a plain function, the same way any other transport-independent
  // callback would be. None of these run a role or ownership check -- `dispatch()` above
  // already did, per the ADR's ordering.

  #catalogGet: Handler<"catalog.get"> = async (input) => ({
    platforms: (await this.options.catalog.listCatalog(input.platform)).map(fitPlatformCatalog),
  });

  #statusGet: Handler<"status.get"> = () => {
    const snapshot = this.options.registry.snapshot;
    const running = this.options.capacity.runningCapacity;
    const warmDevices = snapshot.devices.filter((device) => device.state === "ready");
    const capacity = Object.fromEntries(
      (["ios", "android"] as const).map((platform) => [
        platform,
        {
          limit: this.options.capacity.deviceLimit(platform),
          ...running[platform],
          warm: warmDevices.filter((device) => device.spec.platform === platform).length,
          used: snapshot.devices.filter(
            (device) => device.spec.platform === platform && device.state !== "deleted",
          ).length,
        },
      ]),
    );
    const ramBudget = this.options.capacity.ramBudget;
    return {
      capacity: {
        ...capacity,
        global: { ...running.global, warm: warmDevices.length },
        ...(ramBudget === undefined ? {} : { ramBudget }),
      },
      devices: snapshot.devices.map((device) => this.#decorateDevice(device)),
      // ADR 0005 §1: what this daemon is, as opposed to what it holds. `mode` comes from
      // config rather than being assumed, because it is what tells a client whether the device
      // it leased is on this machine (§19c) -- today every daemon configures `worker`, and
      // #117 is what makes `gateway` mean something beyond this field.
      daemon: {
        health: this.options.health(),
        mode: this.options.config.mode,
        ...consoleUrlField(this.options.config.http),
      },
      host: this.options.hostFacts(),
      installs: [...this.options.components.inProgress()],
      leases: [...snapshot.leases],
      queueDepth: this.options.queue.queueDepth,
      waiting: [...this.options.queue.waitingRequests()],
    };
  };

  // fallow-ignore-next-line complexity -- lease payload assembly and the download-policy rewrite are one transaction, moved verbatim from DaemonServer's former #requestLease.
  #leaseRequest: Handler<"lease.request"> = async (input, session) => {
    const request: DeviceRequest = requestedDevice(input);
    this.#requireTtlWithinCap(input.ttlMs);
    const requesterId = input.requesterId ?? session.principal;
    const requestedAllowDownload = input.allowDownload ?? false;
    const downloadsPolicy = this.options.config.downloads.policy;
    // ADR 0005 §27a (narrowed, round 3 review, H3): `owner` is read only from the gateway's own
    // uplink session -- forwarding the principal it authorized the request against on its own
    // side -- never merely from `role === "admin"`. HTTP's `operator` token maps onto that same
    // role (`dispatcher-session.ts`), so gating on role alone let *any* operator bearer
    // credential set someone else's owner on a plain worker with no gateway anywhere; the field
    // exists for one caller (the gateway's uplink, forced to `admin` by `acceptUplink`
    // regardless of credential -- see `session.isGatewayUplink`'s own doc), not for every
    // session that happens to carry that role. Any session that is not the uplink naming one is
    // rejected outright rather than silently ignored: a caller free to name someone else as
    // owner would be naming its way into their lease, and "ignore the field" would hide that a
    // non-uplink caller tried. Omitting it keeps today's behaviour -- the owner is always the
    // calling connection.
    if (input.owner !== undefined && session.isGatewayUplink !== true) {
      throw new DispatchError(
        "FORBIDDEN",
        "Only the gateway's own uplink session may set lease.request's `owner` field",
      );
    }
    const ownerId = input.owner ?? session.principal;
    try {
      return await this.options.leases.request(request, {
        allowDownload: effectiveAllowDownload(downloadsPolicy, requestedAllowDownload),
        noWait: input.noWait ?? false,
        ownerId,
        requesterId,
        ...(session.onProgress === undefined ? {} : { onProgress: session.onProgress }),
        ...(session.onRequestAdmitted === undefined
          ? {}
          : { onAdmitted: session.onRequestAdmitted }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
    } catch (error: unknown) {
      // The lease path only ever sees the clamped-to-false permission, so it cannot itself
      // tell the caller that config, not missing consent, is what stood between this request
      // and success. Recover that distinction here, the one place that saw both sides. Moved
      // verbatim from `DaemonServer`'s former `#requestLease`.
      if (
        downloadsPolicy === "never" &&
        error instanceof RuntimeMissingError &&
        error.downloadable
      ) {
        error.message = `${error.message} (downloads are disabled by configuration: downloads.policy is "never")`;
      }
      throw error;
    }
  };

  #leaseCancel: Handler<"lease.cancel"> = async (input, session) => {
    const requesterId = input.requesterId ?? session.principal;
    const result = await this.options.queue.cancelPending(requesterId);
    return { result };
  };

  /**
   * ADR 0004 §1: the one keep-alive, on every transport. An omitted `ttlMs` re-applies the
   * lease's own stored width (`LeaseLifecycle#renew`), never `lease.defaultTtlMs`.
   */
  #leaseRenew: Handler<"lease.renew"> = async (input) => {
    this.#requireTtlWithinCap(input.ttlMs);
    return this.options.leases.renew(input.leaseId, input.ttlMs);
  };

  /**
   * ADR 0004 §4's cap, applied identically to a request and a renew. It lives here rather than
   * in the contract schema because `lease.maxTtlMs` is a daemon config value, and the contract
   * module cannot see one; it lives in the dispatcher rather than in each transport because
   * every transport reaches leases through this one shared object (ADR 0003 §2), so HTTP gets
   * the same `400 BAD_REQUEST` the socket gets from the same line of code. Rejecting rather
   * than clamping is the point: a caller silently given less time than it asked for would go
   * on believing it had the time it named.
   */
  #requireTtlWithinCap(ttlMs: number | undefined): void {
    const maxTtlMs = this.options.config.lease.maxTtlMs;
    if (ttlMs !== undefined && ttlMs > maxTtlMs) {
      throw new DispatchError(
        "BAD_REQUEST",
        `ttlMs ${String(ttlMs)} exceeds lease.maxTtlMs (${String(maxTtlMs)})`,
      );
    }
  }

  #leaseRelease: Handler<"lease.release"> = async (input) => {
    await this.options.leases.release(input.leaseId, "explicit");
    return { leaseId: input.leaseId };
  };

  /**
   * `killed`, not `explicit`: `docs/internal/EVENTS.md` splits the two by who ended the lease and
   * whether its holder asked. An operator's `simlock release --all` (and `nuke`, which already
   * reports `killed` through `NukeService`) takes leases away from holders that never asked --
   * which is exactly what a `lease-lost` reader needs to tell apart from the holder's own
   * `lease.release` on its way out.
   */
  #leaseReleaseAll: Handler<"lease.release-all"> = async () => {
    const leaseIds = await this.options.leases.releaseAll("killed");
    return { leaseIds: [...leaseIds] };
  };

  #leaseList: Handler<"lease.list"> = (_input, session) => {
    const leases = this.options.registry.snapshot.leases.filter(
      (lease) => session.role === "admin" || lease.ownerId === session.principal,
    );
    return { leases };
  };

  /**
   * Resolution only: the daemon builds the command and never runs it. Spawning it here would
   * attach a user's interactive `adb shell` to the daemon's stdio, and the CLI is the process
   * that actually has a terminal (ADR 0001, decision 7).
   *
   * Both failure modes leave as their own typed errors -- `PassthroughRefusedError` for a verb
   * the driver will not proxy, `UnknownPassthroughToolError` for a tool no driver claims -- so
   * `errorCode` maps them to `PASSTHROUGH_REFUSED` / `UNKNOWN_PASSTHROUGH_TOOL` and
   * `DaemonServer#describeError` still gets the chance to append the driver's refusal summary.
   */
  #driverPassthrough: Handler<"driver.passthrough"> = (input) => {
    if (this.options.passthrough === undefined) {
      throw new DispatchError("INTERNAL", "Tool passthrough is unavailable");
    }
    return this.options.passthrough.passthrough(input.tool, input.args);
  };

  /**
   * ADR 0005 §19a: the same command `driver.passthrough` would have handed back, run here
   * instead of there. Everything a passthrough already decides is reused verbatim -- which
   * flag scopes the tool to this daemon's root, which verbs the driver refuses -- because it
   * is the same call: `#driverPassthrough` above and this handler differ only in who spawns
   * the result.
   *
   * `leaseId` is proof of ownership and nothing else. It is checked against the registry here
   * so an id that names no lease answers `UNKNOWN_LEASE` rather than running a command
   * (`authorize`'s `ownsLease` deliberately lets an unknown id through so this handler can say
   * that -- see `roles.ts`); the *device* the command touches is named by the command's own
   * arguments, which this daemon does not parse. That is the same accident boundary ADR 0001
   * draws for the local wrappers, reached over the wire.
   *
   * Nothing is buffered: each chunk goes straight to `session.onOutput` as it arrives (§19e),
   * so a command that writes a gigabyte costs this process nothing, and a client sees the
   * first line while the command is still running.
   */
  #deviceExec: Handler<"device.exec"> = async (input, session) => {
    if (this.options.passthrough === undefined) {
      throw new DispatchError("INTERNAL", "Tool passthrough is unavailable");
    }
    if (this.options.processRunner === undefined) {
      throw new DispatchError("INTERNAL", "Command execution is unavailable");
    }
    const lease = this.options.registry.snapshot.leases.find(
      (candidate) => candidate.id === input.leaseId,
    );
    if (lease === undefined) throw new UnknownLeaseError(input.leaseId);

    // `hasTerminal: false` is the one thing this path tells the driver about its caller: the
    // command runs here, with pipes and no pty (ADR 0005 §19c), so a driver may refuse
    // something it allows a local `simlock <tool>` invocation -- a bare `adb shell` would
    // otherwise sit on those pipes until `exec.timeoutMs` killed it.
    const command = this.options.passthrough.passthrough(input.tool, input.args, {
      hasTerminal: false,
    });
    const handle = this.options.processRunner.spawnStreaming(command.command, command.args, {
      env: { ...this.options.execEnv, ...command.env },
      // Returned, not fired and forgotten: whatever the transport hands back is what pauses
      // the child until the chunk has actually gone somewhere (ADR 0005 §19e).
      onChunk: (stream, chunk) => session.onOutput?.(stream, chunk),
      ...(input.stdin === undefined ? {} : { input: input.stdin }),
    });
    // Announced before the first chunk can arrive, because "it started" is what a transport
    // needs to decide its response shape on -- see `DispatchSession.onStarted`.
    session.onStarted?.();
    return { exitCode: await this.#awaitExec(handle, input.tool, input.args) };
  };

  /**
   * Waits for an exec'd command, killing it if it outruns `exec.timeoutMs` (ADR 0005 §19e).
   * SIGTERM first, SIGKILL after a grace window, because a tool that ignores the first must
   * not be able to hold this operation -- and the caller's connection -- open forever; that
   * escalation mirrors `NodeProcessRunner#run`'s own. The timeout is reported as
   * `EXEC_TIMEOUT` rather than as the exit code the kill produced: "we stopped it" and "it
   * failed" are different facts, and only the first tells a caller to raise the limit.
   */
  async #awaitExec(
    handle: StreamingProcessHandle,
    tool: string,
    args: readonly string[],
  ): Promise<number> {
    const timeoutMs = this.options.config.exec.timeoutMs;
    const waited = handle.wait();
    let timer: TimerHandle | undefined;
    const expired = new Promise<typeof EXEC_EXPIRED>((resolve) => {
      timer = this.options.clock.setTimer(timeoutMs, () => resolve(EXEC_EXPIRED));
    });
    let killTimer: TimerHandle | undefined;
    try {
      // Raced rather than decided by a flag the timer sets: a command that exits in the same
      // turn the timer fires has *finished*, and reporting that as a timeout would blame the
      // limit for a command that met it. `Promise.race` settles on whichever actually
      // happened first, which is exactly the question.
      const outcome = await Promise.race([waited, expired]);
      if (outcome !== EXEC_EXPIRED) return exitCodeOf(outcome);

      // SIGTERM first, SIGKILL after a grace window: a tool that ignores the first must not be
      // able to hold this operation -- and the caller's connection -- open forever. The same
      // escalation `NodeProcessRunner#run` makes for its own timeout.
      killQuietly(handle, "SIGTERM");
      killTimer = this.options.clock.setTimer(EXEC_SIGKILL_GRACE_MS, () => {
        killQuietly(handle, "SIGKILL");
      });
      // Once the kill is issued, the timeout is the authoritative fact (ADR 0005 §19e) --
      // `waited` rejecting with `ExecOutputDeliveryStalledError` (a consumer that stopped
      // reading is *why* the command outran its timeout in the first place: the pause that
      // stops it finishing is the same pause that stalls delivery) is a consequence of the
      // timeout, not a competing answer to it. Swallowed here rather than left to reject
      // this `await` and skip the throw below.
      await waited.catch(() => undefined);
      // `EXEC_TIMEOUT` rather than the exit code the kill produced: "we stopped it" and "it
      // failed" are different facts, and only the first tells a caller to raise the limit.
      throw new DispatchError(
        "EXEC_TIMEOUT",
        `\`${tool} ${args.join(" ")}\` exceeded exec.timeoutMs (${String(timeoutMs)}ms) and was killed`,
      );
    } finally {
      if (timer !== undefined) this.options.clock.cancel(timer);
      if (killTimer !== undefined) this.options.clock.cancel(killTimer);
    }
  }

  #doctorRun: Handler<"doctor.run"> = async (input) => {
    if (this.options.doctor === undefined) throw new DoctorUnavailableError();
    // `purgeOrphans` travels as its own flag all the way down, never folded into `fix`:
    // someone already running `doctor --fix` unattended in CI must not acquire a
    // destructive behaviour by upgrading (ADR 0001, decision 6).
    return this.options.doctor.reconcile({
      fix: input.fix ?? false,
      // Only an operator's `doctor` looks at the machine's prerequisites; startup convergence
      // runs no tool.
      prerequisites: true,
      purgeOrphans: input.purgeOrphans ?? false,
    });
  };

  #listGet: Handler<"list.get"> = (input) => {
    const snapshot = this.options.registry.snapshot;
    switch (input.kind) {
      case "leases":
        return [...snapshot.leases];
      case "rules":
        return this.options.reaper.rules;
      case "requests":
        return [...this.options.queue.waitingRequests()];
      case "devices":
      case undefined:
        return snapshot.devices.map((device) => this.#decorateDevice(device));
    }
  };

  #cleanupRun: Handler<"cleanup.run"> = async (input) =>
    this.options.reaper.run({
      dryRun: input.dryRun ?? false,
      ...(input.rule === undefined ? {} : { rule: input.rule }),
    });

  #nukeRun: Handler<"nuke.run"> = async (input) => {
    if (this.options.nuke === undefined) throw new NukeUnavailableError();
    return this.options.nuke.run({ deleteDevices: input.deleteDevices ?? false });
  };

  #eventsReplay: Handler<"events.replay"> = (input) =>
    this.options.eventHistory.replay(input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs });

  #eventsSubscribe: Handler<"events.subscribe"> = (_input, session) => {
    const subscriptionId = session.manageEventSubscription(true);
    if (subscriptionId === undefined) {
      throw new DispatchError("INTERNAL", "Transport did not provide a subscription id");
    }
    return { subscribed: true, subscriptionId };
  };

  #eventsUnsubscribe: Handler<"events.unsubscribe"> = (_input, session) => {
    session.manageEventSubscription(false);
    return { subscribed: false };
  };

  #configGet: Handler<"config.get"> = () => this.options.config;

  /**
   * ADR 0012 §1: this host as its own fleet of one. The fields a gateway reads over the uplink
   * come from the same four reads, made here against this dispatcher's own handlers; the
   * contract's one builder turns them into a view. The parses only turn the handlers' core
   * records into the wire types the builder takes: `worker.list`'s own output schema, applied
   * by `dispatch()`, is what bounds and narrows the view on the wire. The catalog is the kept
   * one (see `#viewCatalog`); status and devices are read on every call, as a gateway reads
   * them on every worker event. `drained` is always `false`: a gateway that drained this worker
   * holds that flag, not this host.
   */
  #workerList: Handler<"worker.list"> = async (_input, session) => {
    const [status, devices, catalog] = await Promise.all([
      this.#statusGet({}, session),
      this.#listGet({ kind: "devices" }, session),
      this.#keptViewCatalog(session),
    ]);
    const label = this.options.config.gateway.label;
    return {
      workers: [
        {
          ...workerViewFields({
            catalog: OPERATIONS["catalog.get"].output.parse(catalog),
            config: OPERATIONS["config.get"].output.parse(this.#configGet({}, session)),
            devices: OPERATIONS["list.get"].output.parse(devices),
            status: OPERATIONS["status.get"].output.parse(status),
          }),
          connection: "connected",
          drained: false,
          id: this.options.instanceId,
          lastSeenAt: this.options.clock.now(),
          version: this.options.version,
          ...(label === undefined ? {} : { label }),
        },
      ],
    };
  };

  /**
   * The kept catalog for `worker.list`, read again once it is older than the interval. The age
   * is wall-clock time, so one that is negative (the clock was set back) counts as stale rather
   * than keeping the catalog for as long as the clock went back. A failed read drops whatever is
   * kept, at worst one read newer than it, which costs one more read.
   */
  #keptViewCatalog(session: DispatchSession): Promise<unknown> {
    const now = this.options.clock.now();
    const kept = this.#viewCatalog;
    const age = kept === undefined ? undefined : now - kept.readAt;
    if (
      kept !== undefined &&
      age !== undefined &&
      age >= 0 &&
      age < WORKER_VIEW_REFRESH_INTERVAL_MS
    ) {
      return kept.catalog;
    }
    const catalog = Promise.resolve(this.#catalogGet({}, session));
    this.#viewCatalog = { catalog, readAt: now };
    catalog.catch(() => {
      this.#viewCatalog = undefined;
    });
    return catalog;
  }

  /**
   * ADR 0010 §4 and §6: an operator's explicit install. The command itself is the consent, so the
   * one consent function is asked with `true`; only `downloads.policy: "never"` refuses it, and it
   * does so before the installer is reached. Everything else -- joining an install already
   * running, waiting a platform's turn, the disk reservation, the budget, the events -- is the
   * installer's, exactly as for a lease request's download.
   */
  #componentInstall: Handler<"component.install"> = async (input, session) => {
    if (!effectiveAllowDownload(this.options.config.downloads.policy, true)) {
      throw new DispatchError(
        "DOWNLOADS_DISABLED",
        'Downloads are disabled by configuration: downloads.policy is "never"',
        { policy: "never" },
      );
    }
    const onComponentProgress = session.onComponentProgress;
    const onStarted = session.onStarted;
    const result = await this.options.components.install({
      component: input.version,
      platform: input.platform,
      requesterId: session.principal,
      ...(onComponentProgress === undefined
        ? {}
        : { onProgress: (progress) => onComponentProgress(toWireProgress(progress)) }),
      ...(onStarted === undefined ? {} : { onAdmitted: onStarted }),
    });
    // No `stillNeeded` is passed, so `not-needed` cannot come back; a version is always present
    // for the two outcomes that can.
    if (result.outcome === "not-needed" || result.version === undefined) {
      throw new Error(`Internal: component install ended as ${result.outcome} with no version`);
    }
    return {
      component: input.version,
      outcome: result.outcome,
      platform: input.platform,
      version: result.version,
    };
  };

  /** ADR 0010 §8: a read for any session; the installer merges the drivers and the registry. */
  #componentList: Handler<"component.list"> = async (input) => ({
    components: await this.options.components.list(input.platform),
  });

  /**
   * ADR 0010 §8: an operator's removal of a component Simlock installed. Every check and the
   * removal itself are the installer's; this names the admin principal for `component.removed`
   * (safety rule 6) and puts the in-use counts on the wire as `COMPONENT_IN_USE`'s details.
   */
  #componentRemove: Handler<"component.remove"> = async (input, session) => {
    try {
      const result = await this.options.components.remove({
        platform: input.platform,
        requesterId: session.principal,
        version: input.version,
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      });
      return { platform: input.platform, version: input.version, ...result };
    } catch (error: unknown) {
      if (error instanceof ComponentInUseError) {
        throw new DispatchError("COMPONENT_IN_USE", error.message, {
          devices: error.devices,
          foreignDevices: error.foreignDevices,
        });
      }
      throw error;
    }
  };

  /**
   * ADR §11: the daemon is the only owner of `tokens.json` -- `TokenStore.create` never
   * persists the plaintext `secret`, only its hash, exactly as it did when the CLI called it
   * directly.
   */
  #tokenCreate: Handler<"token.create"> = async (input) => {
    const { record, secret } = await this.#requireTokens().create(input.role, input.label);
    return { secret, token: record };
  };

  #tokenList: Handler<"token.list"> = async () => ({ tokens: await this.#requireTokens().list() });

  #tokenRevoke: Handler<"token.revoke"> = async (input) => ({
    revoked: await this.#requireTokens().revoke(input.id),
  });

  #requireTokens(): TokenStore {
    if (this.options.tokens === undefined) {
      throw new DispatchError("INTERNAL", "Token store is unavailable");
    }
    return this.options.tokens;
  }

  /** Moved verbatim from `DaemonServer`; see its former comment there. */
  #decorateDevice(device: DeviceRecord): DeviceRecord & { readonly transitionAgeMs?: number } {
    const enteredAt = transitionEnteredAt(device);
    if (enteredAt === undefined) return device;
    return { ...device, transitionAgeMs: this.options.clock.now() - enteredAt };
  }
}

/**
 * The installer's progress in the contract's words: its percentage, already within 0..100,
 * becomes a fraction from 0 to 1, rounded to three decimals so that 1.1 percent is 0.011 and not
 * the 0.011000000000000001 a plain division gives. Only 100 percent becomes 1: 99.96 would round
 * up to it, and 1 is what an install says once it is complete. With none (the install has just
 * started, or the driver's was not a number) there is no fraction.
 */
function toWireProgress(progress: ComponentInstallerProgress): ComponentProgress {
  if (progress.stage === "waiting") return { stage: "waiting" };
  if (progress.percent === undefined) return { stage: "downloading" };
  const fraction = Math.round(progress.percent * 10) / 1000;
  return { fraction: progress.percent < 100 ? Math.min(fraction, 0.999) : 1, stage: "downloading" };
}

/** A child that exited between the timer firing and the signal landing is not an error worth
 * failing the operation over -- the wait below is about to report how it ended anyway. */
function killQuietly(handle: StreamingProcessHandle, signal: NodeJS.Signals): void {
  try {
    handle.kill(signal);
  } catch {
    // Already gone.
  }
}

/** ADR 0012 §2: an operation that acts on a gateway's workers, asked of a worker. */
function unsupportedOnWorker(
  operation: OperationName,
  message = `${operation} acts on a gateway's workers, and this daemon is not a gateway`,
): ErasedHandler {
  return () => {
    throw new DispatchError("UNSUPPORTED_IN_WORKER_MODE", message, { operation });
  };
}
