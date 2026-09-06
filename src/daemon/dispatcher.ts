import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import {
  type CleanupReaper,
  type Config,
  type DeviceRecord,
  type DeviceRequest,
  type Doctor,
  type LeaseProgress,
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
  describeSchemaIssues,
  OPERATIONS,
  type OperationDefinition,
  type OperationName,
  type AuthorizeContext,
  type Role,
} from "../contract/index.js";
import type { TokenStore } from "../http/token-store.js";

/**
 * ADR 0003 §2's "session" argument to `dispatch`. Constructed fresh per call by the transport
 * (today: `DaemonServer`, one per socket request) from whatever longer-lived state it owns --
 * this type does not itself track anything across calls.
 *
 * `principal`/`role` are the ADR §4/§5 identity: fixed for the connection's lifetime once
 * `hello` resolves them (see `session.ts`'s `SessionRoleResolver` seam -- PR 2's credential
 * handshake replaces how `role` is computed, not this shape). ADR 0004 removes the two
 * connection-scoped fields that used to sit beside them (`heldLeaseIds`,
 * `heartbeatCapability`): the daemon keeps no per-connection lease state at all any more, and
 * the one operation that read them is gone. `onProgress` and `manageEventSubscription` are the
 * two places a request-scoped or connection-scoped push actually reaches the wire -- `DaemonServer` supplies
 * closures that write socket frames; an HTTP session (next PR) can leave `onProgress` unset and
 * fail loudly (or no-op) on `events.subscribe`, since HTTP has no open connection to push
 * through even in principle (ADR §8's "the HTTP notice buffer stays").
 */
export interface DispatchSession {
  readonly principal: string;
  readonly role: Role;
  /** Called for each progress update while this specific `lease.request` call is in flight.
   * Ignored by every other operation. */
  readonly onProgress?: (progress: LeaseProgress) => void;
  /**
   * Called for each chunk a `device.exec` command writes, as it writes it (ADR 0005 §19a's
   * `output` push family). Ignored by every other operation, and left unset by a transport
   * that has nowhere to put a chunk -- in which case the command still runs and still reports
   * its exit code, and the output is simply not relayed. The same shape as `onProgress`, for
   * the same reason: both are request-scoped pushes, and the dispatcher stays out of framing.
   */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Called once, for a `device.exec` call, the moment its process is running -- after every
   * failure that can happen *before* one exists (a refused verb, an unknown tool, an unowned
   * lease, a daemon still starting) and before any output. A transport that has to commit to
   * a response shape uses it as the decision point: HTTP opens its event stream here, so a
   * command that prints nothing for nine minutes still gets its `200` and its keepalives, and
   * an `EXEC_TIMEOUT` always arrives as that stream's terminal event rather than as a status
   * code the client cannot receive any more (ADR 0005 §19e).
   */
  readonly onStarted?: () => void;
  /** `events.subscribe`/`events.unsubscribe` stay push-shaped (ADR §2: "pushes" stay with the
   * transport), so the dispatcher's handler for them does nothing but call this: `true` to
   * (re)subscribe, returning the new subscription id; `false` to tear an existing one down. */
  readonly manageEventSubscription: (subscribe: boolean) => string | undefined;
}

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

/** Thrown for a role/ownership rejection or a malformed request; `DaemonServer` maps this the
 * same way it already maps its own protocol errors (see `errorCode` in `server.ts`). */
export class DispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

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
  readonly config: Config;
  readonly doctor?: Doctor;
  readonly eventBus: EventBus;
  readonly leases: LeaseCommands;
  readonly logger?: Logger;
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
  /**
   * ADR §2 step 4: every operation but `status.get` parks here before its handler runs.
   * `hello` never reaches `dispatch()` at all -- it is answered before a `Session` exists,
   * since the session's `role` is itself resolved from `hello`'s payload (see `session.ts`).
   */
  readonly awaitReady: () => Promise<void>;
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

/** The type `#handlers` and `dispatch()` actually traffic in: a `Handler<Op>` for some
 * particular `Op`, erased to `never` input so the lookup table can hold every operation's
 * handler side by side (a function accepting a narrower/`never` input is a valid supertype
 * target for one accepting a wider input, so every concrete `Handler<Op>` assigns into this).
 * `dispatch()` casts its already-schema-validated `input` to `never` at the one call site that
 * needs it -- the same "trust the runtime validation, not the type checker" boundary every
 * other generic-over-a-closed-union dispatch table in this codebase (e.g. `OPERATIONS` itself)
 * accepts. */
type AnyHandler = (input: never, session: DispatchSession) => Promise<unknown> | unknown;

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
  /**
   * Total over every operation but `daemon.stop`. Deliberately *not* a partial map: a
   * declared operation whose handler was never written is otherwise invisible to the
   * compiler and only shows up as `UNKNOWN_REQUEST` at runtime -- which is exactly how
   * `driver.passthrough` came to be declared, dispatched, and unimplemented at once.
   */
  readonly #handlers: Record<Exclude<OperationName, "daemon.stop">, AnyHandler>;

  constructor(private readonly options: DispatcherOptions) {
    this.#logger = options.logger ?? new NoopLogger();
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
      // "daemon.stop" deliberately absent -- see the class comment; `DaemonServer` never calls
      // `dispatch()` for a frame type this map has no entry for.
    };
  }

  async dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    // Same "generic-over-a-closed-union" cast `AnyHandler` needed above: `OPERATIONS[operation]`
    // for a generic `Op` collapses to a union across every operation, and TypeScript refuses to
    // call a union of functions (`.role`, `.authorize`) with a generically-typed argument even
    // though each concrete instantiation is sound. `OPERATIONS` is a closed, exhaustively-typed
    // record (see `operations.ts`) validated by its own test suite -- this cast trusts that
    // shape, not the runtime, so it is not the same kind of escape hatch as `input as never`
    // below (that one truly is unverified until `parseInput` runs).
    const definition = OPERATIONS[operation] as unknown as OperationDefinition;
    // `#handlers` is total over every operation but `daemon.stop`, so the only `Op` this
    // lookup can miss is that one -- and `DaemonServer` intercepts it before `dispatch()`.
    // The cast states that; the guard below still covers a caller that ignores the rule,
    // since an absent handler must not become `undefined is not a function`.
    const handler: AnyHandler | undefined =
      this.#handlers[operation as Exclude<OperationName, "daemon.stop">];
    if (handler === undefined) {
      throw new DispatchError("UNKNOWN_REQUEST", `Unknown request type: ${operation}`);
    }

    const input = parseInput(definition.input, rawInput ?? {});
    const requiredRole: Role =
      typeof definition.role === "function" ? definition.role(input) : definition.role;
    if (!roleSatisfies(session.role, requiredRole)) {
      throw new DispatchError(
        "FORBIDDEN",
        `Operation ${operation} requires role ${requiredRole}, session is ${session.role}`,
      );
    }
    if (definition.authorize !== undefined) {
      const context: AuthorizeContext = {
        ownerId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.ownerId,
        leaseRequesterId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.requesterId,
        pendingRequestOwner: (requesterId) => this.options.queue.pendingRequestOwner(requesterId),
        principal: session.principal,
        role: session.role,
      };
      if (!definition.authorize(input, context)) {
        throw new DispatchError("FORBIDDEN", `Not authorized for ${operation}`);
      }
    }

    if (operation !== "status.get") {
      await this.options.awaitReady();
    }

    const output = await handler(input as never, session);
    return this.#parseOutput(definition.output, output, operation);
  }

  // ---- handlers ---------------------------------------------------------------------------
  // Arrow-function class fields (not methods): each closes over `this` so it can be stored in
  // `#handlers` and invoked as a plain function, the same way any other transport-independent
  // callback would be. None of these run a role or ownership check -- `dispatch()` above
  // already did, per the ADR's ordering.

  #catalogGet: Handler<"catalog.get"> = async (input) => ({
    platforms: await this.options.catalog.listCatalog(input.platform),
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
    return {
      capacity: { ...capacity, global: { ...running.global, warm: warmDevices.length } },
      devices: snapshot.devices.map((device) => this.#decorateDevice(device)),
      health: this.options.health(),
      leases: [...snapshot.leases],
      // ADR 0005 §1: one daemon, one mode, and today there is exactly one mode to be in --
      // this daemon owns devices, so it is a worker. Reported rather than assumed because it
      // is what tells a client whether the device it leased is on this machine (§19c); #117
      // makes it configurable and can then report `"gateway"` here.
      mode: "worker" as const,
      queueDepth: this.options.queue.queueDepth,
    };
  };

  // fallow-ignore-next-line complexity -- lease payload assembly and the download-policy rewrite are one transaction, moved verbatim from DaemonServer's former #requestLease.
  #leaseRequest: Handler<"lease.request"> = async (input, session) => {
    const request: DeviceRequest = {
      model: input.model,
      platform: input.platform,
      ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
      ...(input.full ? { full: true } : {}),
    };
    this.#requireTtlWithinCap(input.ttlMs);
    const requesterId = input.requesterId ?? session.principal;
    const requestedAllowDownload = input.allowDownload ?? false;
    const downloadsPolicy = this.options.config.downloads.policy;
    try {
      return await this.options.leases.request(request, {
        allowDownload: effectiveAllowDownload(downloadsPolicy, requestedAllowDownload),
        noWait: input.noWait ?? false,
        // ADR §4: the lease's owner is always the session principal -- never client-supplied,
        // unlike `requesterId`.
        ownerId: session.principal,
        requesterId,
        ...(session.onProgress === undefined ? {} : { onProgress: session.onProgress }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
    } catch (error: unknown) {
      // The driver only ever sees the clamped-to-false permission, so it cannot itself tell
      // the caller that config, not missing consent, is what stood between this request and
      // success. Recover that distinction here, the one place that saw both sides. Moved
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
   * `killed`, not `explicit`: `docs/EVENTS.md` splits the two by who ended the lease and
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
      await waited;
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
    this.options.eventBus.replay(input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs });

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

  #parseOutput<Output>(schema: z.ZodType<Output>, value: unknown, operationName: string): Output {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    this.#logger.error("Operation output failed contract validation", {
      operation: operationName,
      issues: result.error.issues,
    });
    throw new Error(
      `Internal: ${operationName} produced a response that does not match its contract output schema`,
    );
  }
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

function roleSatisfies(sessionRole: Role, required: Role): boolean {
  return sessionRole === "admin" || required === "agent";
}

function parseInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new DispatchError("BAD_REQUEST", describeSchemaIssues(result.error.issues));
}
