import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import {
  type CleanupReaper,
  type Config,
  type DeviceRecord,
  type DeviceRequest,
  type Doctor,
  type LeaseProgress,
  type LeaseRecord,
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
import type { Clock, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import {
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
 * handshake replaces how `role` is computed, not this shape). `heldLeaseIds`/
 * `heartbeatCapability` are connection-scoped facts `DaemonServer` already owns (ADR §2: the
 * dispatcher does not do "held-lease tracking" or "connection lifecycle", the transport does);
 * they are threaded in read-only because `lease.heartbeat`'s ownership rule ("this connection's
 * held leases") needs them. `onProgress` and `manageEventSubscription` are the two places a
 * request-scoped or connection-scoped push actually reaches the wire -- `DaemonServer` supplies
 * closures that write socket frames; an HTTP session (next PR) can leave `onProgress` unset and
 * fail loudly (or no-op) on `events.subscribe`, since HTTP has no open connection to push
 * through even in principle (ADR §8's "the HTTP notice buffer stays").
 */
export interface DispatchSession {
  readonly principal: string;
  readonly role: Role;
  readonly heldLeaseIds: ReadonlySet<string>;
  readonly heartbeatCapability: boolean;
  /** Called for each progress update while this specific `lease.request` call is in flight.
   * Ignored by every other operation. */
  readonly onProgress?: (progress: LeaseProgress) => void;
  /** `events.subscribe`/`events.unsubscribe` stay push-shaped (ADR §2: "pushes" stay with the
   * transport), so the dispatcher's handler for them does nothing but call this: `true` to
   * (re)subscribe, returning the new subscription id; `false` to tear an existing one down. */
  readonly manageEventSubscription: (subscribe: boolean) => string | undefined;
}

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
      "lease.heartbeat": this.#leaseHeartbeat,
      "driver.passthrough": this.#driverPassthrough,
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
      leases: snapshot.leases.map((lease) => this.#decorateLease(lease)),
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
    const mode = input.mode ?? "held";
    const requesterId = input.requesterId ?? session.principal;
    const requestedAllowDownload = input.allowDownload ?? false;
    const downloadsPolicy = this.options.config.downloads.policy;
    try {
      return await this.options.leases.request(request, {
        allowDownload: effectiveAllowDownload(downloadsPolicy, requestedAllowDownload),
        mode,
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

  #leaseRenew: Handler<"lease.renew"> = async (input) =>
    this.options.leases.renew(input.leaseId, input.ttlMs);

  #leaseRelease: Handler<"lease.release"> = async (input) => {
    await this.options.leases.release(input.leaseId, "explicit");
    return { leaseId: input.leaseId };
  };

  #leaseReleaseAll: Handler<"lease.release-all"> = async () => {
    const leaseIds = await this.options.leases.releaseAll("explicit");
    return { leaseIds: [...leaseIds] };
  };

  #leaseList: Handler<"lease.list"> = (_input, session) => {
    const leases = this.options.registry.snapshot.leases
      .filter((lease) => session.role === "admin" || lease.ownerId === session.principal)
      .map((lease) => this.#decorateLease(lease));
    return { leases };
  };

  #leaseHeartbeat: Handler<"lease.heartbeat"> = async (_input, session) => {
    if (!session.heartbeatCapability) {
      throw new DispatchError("BAD_REQUEST", "Connection did not declare the heartbeat capability");
    }
    const acked: Array<{ readonly leaseId: string; readonly ttlDeadline: number }> = [];
    for (const leaseId of session.heldLeaseIds) {
      try {
        const renewed = await this.options.leases.heartbeat(leaseId);
        acked.push({ leaseId: renewed.id, ttlDeadline: renewed.ttlDeadline });
      } catch (error: unknown) {
        if (!(error instanceof UnknownLeaseError)) throw error;
      }
    }
    return { leases: acked };
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
        return snapshot.leases.map((lease) => this.#decorateLease(lease));
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

  /**
   * Adds a derived `lastHeartbeatAt` for held leases, without a new `LeaseRecord` field: since
   * `heartbeat()` writes through the registry, `ttlDeadline - heldTtlBackstopMs` is exactly the
   * moment of the most recent slide (or grant, if there hasn't been one yet). Moved verbatim
   * from `DaemonServer`.
   */
  #decorateLease(lease: LeaseRecord): LeaseRecord & { readonly lastHeartbeatAt?: number } {
    if (lease.mode !== "held") return lease;
    return {
      ...lease,
      lastHeartbeatAt: lease.ttlDeadline - this.options.config.lease.heldTtlBackstopMs,
    };
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

function roleSatisfies(sessionRole: Role, required: Role): boolean {
  return sessionRole === "admin" || required === "agent";
}

function parseInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const description = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
  throw new DispatchError("BAD_REQUEST", description);
}
