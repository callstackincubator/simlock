import { z } from "zod";

import { type EventBus, type EventEnvelope } from "../bus/index.js";
import {
  type Config,
  type DeviceRecord,
  type DeviceRequest,
  type LeaseProgress,
  type LeaseRecord,
  effectiveAllowDownload,
  InsufficientDiskSpaceError,
  LicenseNotAcceptedError,
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  type Registry,
  RequesterAlreadyLeasedError,
  RuntimeMissingError,
  transitionEnteredAt,
  UnknownModelError,
  type CleanupReaper,
  type Doctor,
  type LeaseHealthMonitor,
  type Nuke,
  UnknownLeaseError,
} from "../core/index.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseCommands,
  QueueControl,
} from "../core/lease-ports.js";
import type { Clock, IpcConnection, Logger, TimerHandle } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { parseRequestFrame, serializeFrame, type RequestFrame } from "../daemon-protocol/index.js";
import {
  catalogGet,
  cleanupRun,
  configGet,
  doctorRun,
  eventsReplay,
  eventsSubscribe,
  eventsUnsubscribe,
  helloRequestSchema,
  helloReplySchema,
  leaseCancel,
  leaseHeartbeat,
  leaseList,
  leaseRelease,
  leaseReleaseAll,
  leaseRenew,
  leaseRequest,
  listGet,
  negotiateProtocolVersion,
  normalizeProtocolVersion,
  nukeRun,
  PROTOCOL_VERSION_RANGE,
  PUSH_SCHEMAS,
  statusGet,
  type ProtocolRange,
} from "../contract/index.js";
import type { ConnectionHost } from "./connection-host.js";

type RequestId = string | number;

interface Connection {
  readonly socket: IpcConnection;
  readonly heldLeaseIds: Set<string>;
  readonly progressDisposers: Set<() => void>;
  readonly progressRequesters: Set<string>;
  buffer: string;
  helloReceived: boolean;
  heartbeatCapability: boolean;
  closed: boolean;
  unsubscribeEvents: (() => void) | undefined;
  /** Set while this connection has an active `events.subscribe`; correlates `event` pushes
   * (ADR 0003 §8). Minted per-subscription from `#eventSubscriptionSeq` rather than injected --
   * `DaemonServer` has no `IdGenerator` dependency today, and this only needs to be unique per
   * connection lifetime, not globally unpredictable. */
  subscriptionId: string | undefined;
  releasing: Promise<void> | undefined;
}

export interface DaemonServerOptions {
  readonly capacity: CapacityReader;
  readonly catalog: CatalogReader;
  readonly clock: Clock;
  readonly config: Config;
  readonly doctor?: Doctor;
  readonly defaultRequesterId: string;
  readonly eventBus: EventBus;
  readonly host: ConnectionHost;
  readonly leases: LeaseCommands;
  readonly logger?: Logger;
  /** Overrides the daemon's advertised protocol range (ADR 0003 §6); defaults to
   * `PROTOCOL_VERSION_RANGE`. A bare number is normalized to `{n, n}`, same as a client's. */
  readonly protocolVersion?: number | ProtocolRange;
  readonly queue: QueueControl;
  readonly reaper: CleanupReaper;
  readonly healthMonitor?: LeaseHealthMonitor;
  readonly nuke?: Nuke;
  readonly registry: Registry;
  readonly version: string;
  /**
   * Startup recovery work (doctor reconciliation, running-capacity convergence) run
   * *after* the socket is claimed, so reachability never depends on it. `hello` and
   * `status.get` answer immediately; every other request type parks on this promise.
   * A rejection here stops the daemon rather than leaving it half-open — see `start()`.
   */
  readonly converge?: () => Promise<void>;
  /**
   * Awaits lease work the subsystem is finishing off its callers' paths — today the
   * backgrounded device reclaims a release hands off (see `LeaseReleaseCoordinator`).
   * A graceful stop drains it so the pool is left settled; an ungraceful death leaves
   * it for startup recovery. Runs after held leases are released and before `dispose`.
   */
  readonly settle?: () => Promise<void>;
  /** Cancels any timers the lease subsystem armed (e.g. quarantine retries) on shutdown. */
  readonly dispose?: () => void;
  /**
   * Stops an auxiliary frontend (today: the HTTP gateway's listener, started only after
   * `start()` resolves -- see `main.ts`) before anything else in `stop()` runs, so no
   * request arriving through it can ever observe a stopping engine. A no-op default when
   * no auxiliary frontend is running.
   */
  readonly stopAuxiliary?: () => Promise<void>;
}

type DaemonHealth = "starting" | "running" | "failed";

export class DaemonServer {
  readonly #connections = new Set<Connection>();
  readonly #protocolRange: ProtocolRange;
  readonly #unsubscribeLeaseLost: Array<() => void> = [];
  readonly #logger: Logger;
  #heartbeatTimer: TimerHandle | undefined;
  #heartbeatNonce = 0;
  #eventSubscriptionSeq = 0;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #health: DaemonHealth = "starting";
  #readyPromise: Promise<void> | undefined;
  /**
   * Every `#dispatchLine` call that starts while `#health` is still `"starting"`,
   * tracked so a convergence failure can genuinely drain them -- await each one's
   * own response actually being written -- before closing sockets, rather than
   * hoping a `stop()` scheduling gap gives them time to run. See the catch in
   * `start()`.
   */
  readonly #parkedDispatches = new Set<Promise<void>>();

  constructor(private readonly options: DaemonServerOptions) {
    this.#protocolRange =
      options.protocolVersion === undefined
        ? PROTOCOL_VERSION_RANGE
        : normalizeProtocolVersion(options.protocolVersion);
    this.#logger = options.logger ?? new NoopLogger();
  }

  // fallow-ignore-next-line unused-class-member -- retained as a daemon compatibility facade.
  get socketPath(): string {
    return this.options.host.endpoint;
  }

  /** Public read of `#health` for an auxiliary frontend (e.g. the HTTP gateway's `daemonHealth`) that needs it without becoming a privileged internal itself. */
  get health(): DaemonHealth {
    return this.#health;
  }

  /**
   * Claims the socket first so reachability never depends on startup recovery work:
   * a lost startup race throws `DaemonAlreadyRunningError` here, before `converge()`
   * runs any device work. Only after the claim does convergence run; `hello` and
   * `status.get` answer throughout, every other request parks on `#readyPromise`
   * (see `#awaitReady`). Node keeps servicing accepted connections while this
   * function's own awaits are pending, so callers observe the socket as connectable
   * well before this promise settles.
   */
  async start(): Promise<void> {
    await this.options.host.start((connection) => this.#accept(connection));
    const readyPromise = this.#converge();
    this.#readyPromise = readyPromise;
    try {
      await readyPromise;
    } catch (error: unknown) {
      // Convergence failed after the socket was claimed: stop rather than sit there
      // accepting connections we can never serve. Drain `#parkedDispatches` first --
      // genuinely wait for each dispatch that started during the window to finish,
      // not just for `#awaitReady()` to reject -- so a request already parked on
      // `#readyPromise` gets its `DAEMON_STARTUP_FAILED` response actually written
      // before `stop()` below closes its socket. This is not a hopeful scheduling
      // gap: `#dispatchLine` awaits its own response write before returning, so
      // draining the tracked promise really does wait for that write. A dispatch
      // that hasn't reached the gate yet, or a brand-new connection that arrives in
      // the narrow window between this drain and `stop()` flipping `#stopping`,
      // still degrades safely -- the client sees the socket close, which since #40
      // surfaces as typed `DAEMON_CONNECTION_LOST`, not a hang.
      await Promise.allSettled(this.#parkedDispatches);
      await this.stop("convergence-failed").catch(() => undefined);
      throw error;
    }

    // Subscribed only now, after convergence, not before `start()` claimed the
    // socket: the only thing that emits `lease.released` during convergence is
    // `convergeRunningCapacity()`'s own orphaned-held-lease release, and by
    // definition no live connection holds an orphaned lease on a daemon that has
    // just started (a held lease's liveness is its daemon connection, which cannot
    // have survived the restart). So nothing emitted during the window needs a
    // `lease-lost` push. A parked `lease.request` is safe too: `start()`'s own
    // continuation is registered on `#readyPromise` before any later request's (the
    // client can only reach the gate after `host.start()`'s callback is wired, well
    // after `start()` began awaiting), so on the shared microtask queue this
    // subscribe runs before any parked request resumes past `#awaitReady()` -- see
    // "answers hello and status.get..." / "parks a request type..." tests, and the
    // dedicated ordering test below. The next event type added that can fire during
    // convergence should re-check this invariant rather than assume it still holds.
    //
    // `device.crash-detected` / `device.recovered` re-checked: the health monitor
    // that emits them is only started after convergence too (see `LeaseEngine` /
    // `DaemonServer` startup wiring), so neither can fire during this window either
    // -- the same "nothing emitted during convergence needs a push" argument holds.
    this.#unsubscribeLeaseLost.push(
      this.options.eventBus.subscribe("lease.expired", (envelope) =>
        this.#notifyLeaseLost(envelope.payload.leaseId, envelope.payload.deviceId, "expired"),
      ),
      this.options.eventBus.subscribe("lease.released", (envelope) =>
        this.#notifyLeaseLost(
          envelope.payload.leaseId,
          envelope.payload.deviceId,
          envelope.payload.reason,
        ),
      ),
      this.options.eventBus.subscribe("device.crash-detected", (envelope) =>
        this.#notifyDeviceUnhealthy(envelope.payload.leaseId, envelope.payload.deviceId),
      ),
      this.options.eventBus.subscribe("device.recovered", (envelope) =>
        this.#notifyDeviceRecovered(
          envelope.payload.leaseId,
          envelope.payload.deviceId,
          envelope.payload.attempts,
        ),
      ),
    );

    this.options.eventBus.emit(
      "daemon.started",
      { configSnapshot: this.options.config, version: this.options.version },
      "daemon",
    );
    this.#logger.info("Daemon started", {
      config: this.options.config,
      protocolVersion: this.#protocolRange.max,
      protocolRange: this.#protocolRange,
      socketPath: this.options.host.endpoint,
      version: this.options.version,
    });
    this.#scheduleHeartbeatTick();
    // Armed only here, after convergence: a probe tick shells out per platform, and
    // convergence is already doing that per driver and device. Starting it late is
    // also what keeps the subscriptions above safe -- nothing can emit
    // device.crash-detected during the startup window, because the only emitter is
    // this monitor.
    this.options.healthMonitor?.start();
  }

  async #converge(): Promise<void> {
    try {
      await this.options.converge?.();
      this.#health = "running";
    } catch (error: unknown) {
      this.#health = "failed";
      this.#logger.error("Daemon failed to converge at startup", {
        message: errorMessage(error),
        stack: errorStack(error),
      });
      throw error;
    }
  }

  /** Every request type but `hello` (handled separately) and `status.get` parks here. */
  async #awaitReady(): Promise<void> {
    if (this.#readyPromise === undefined) return;
    try {
      await this.#readyPromise;
    } catch {
      throw new StartupFailedError();
    }
  }

  stop(reason = "requested"): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#stopping = true;
    this.#stopPromise = this.#stop(reason);
    return this.#stopPromise;
  }

  async #stop(reason: string): Promise<void> {
    // Awaited first, before anything below: an auxiliary frontend calls the role
    // interfaces directly rather than parking on `#awaitReady`/this method's own
    // teardown order, so it must be shut off before held-lease release and
    // lease/queue teardown begin -- otherwise a request arriving through it mid-stop
    // could run against an engine already being torn down.
    await this.options.stopAuxiliary?.();
    this.#logger.info("Daemon stopping", { reason });
    this.options.eventBus.emit("daemon.stopping", { reason }, "daemon");
    if (this.#heartbeatTimer !== undefined) {
      this.options.clock.cancel(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    for (const unsubscribe of this.#unsubscribeLeaseLost.splice(0)) unsubscribe();
    this.options.reaper.dispose();
    this.options.healthMonitor?.dispose();
    await Promise.all([...this.#connections].map((connection) => this.#releaseHeld(connection)));
    // Those releases only commit the registry half and hand the purge off; draining it
    // here keeps `daemon stop` finishing on a settled pool, as it did when the reclaim
    // was inline. Disposal follows rather than precedes it, so a retry timer armed by a
    // reclaim that settles into quarantine is still cancelled.
    await this.options.settle?.();
    this.options.dispose?.();
    for (const connection of this.#connections) {
      await connection.socket.close();
    }
    await this.options.host.stop();
    this.#logger.info("Daemon stopped", { reason });
  }

  #accept(socket: IpcConnection): void {
    if (this.#stopping) {
      void socket.close();
      return;
    }
    const connection: Connection = {
      buffer: "",
      closed: false,
      helloReceived: false,
      heartbeatCapability: false,
      heldLeaseIds: new Set(),
      progressDisposers: new Set(),
      progressRequesters: new Set(),
      socket,
      releasing: undefined,
      subscriptionId: undefined,
      unsubscribeEvents: undefined,
    };
    this.#connections.add(connection);
    socket.onData((chunk) => this.#read(connection, chunk));
    socket.onClose(() => this.#closeConnection(connection));
    socket.onError(() => this.#closeConnection(connection));
  }

  #read(connection: Connection, chunk: string): void {
    connection.buffer += chunk;
    for (;;) {
      const newline = connection.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line.trim() === "") {
        continue;
      }
      this.#dispatch(connection, line);
    }
  }

  /**
   * Fires `#dispatchLine` without awaiting it, same as before, but while `#health` is
   * still `"starting"` also tracks the call in `#parkedDispatches` so a convergence
   * failure can drain it deterministically. Tracking every dispatch during the
   * window (not just the ones that turn out to park) is simplest and harmless --
   * `hello`/`status.get` calls just settle almost immediately and fall out of the set.
   */
  #dispatch(connection: Connection, line: string): void {
    const dispatched = this.#dispatchLine(connection, line);
    if (this.#health !== "starting") {
      void dispatched;
      return;
    }
    this.#parkedDispatches.add(dispatched);
    void dispatched.finally(() => this.#parkedDispatches.delete(dispatched));
  }

  async #dispatchLine(connection: Connection, line: string): Promise<void> {
    let frame: RequestFrame;
    try {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new ProtocolError("BAD_FRAME", "Invalid JSON frame");
      }
      const parsed = parseRequestFrame(value);
      if (parsed === undefined) {
        throw new ProtocolError(
          "BAD_FRAME",
          "Request frame requires string or number id and string type",
        );
      }
      frame = parsed;
    } catch (error: unknown) {
      await this.#respondError(connection.socket, null, "BAD_FRAME", errorMessage(error));
      return;
    }

    // `daemon.stop` is a frozen exception (ADR 0003 §6): accepted at any protocol version the
    // daemon has ever spoken, before `hello`, during a version-mismatch standoff, even while
    // already `#stopping`. This bypasses the handshake and protocol-version gate entirely --
    // deliberately, not an oversight -- so that `npm upgrade` against a still-running old
    // daemon (leases held) can always be stopped without releasing every held lease on the
    // machine by restarting it instead (see ADR §6's "the client never restarts the daemon on
    // mismatch"). It is intentionally idempotent: `stop()` itself dedups concurrent callers via
    // `#stopPromise`, so a second `daemon.stop` here just gets the same success reply again.
    if (frame.type === "daemon.stop") {
      await writeFrame(connection.socket, { id: frame.id, ok: true, payload: { stopping: true } });
      void this.stop("requested");
      return;
    }

    if (!connection.helloReceived) {
      await this.#handleHello(connection, frame);
      return;
    }
    if (this.#stopping) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "DAEMON_STOPPING",
        "Daemon is stopping",
      );
      return;
    }

    try {
      const payload = await this.#handleRequest(connection, frame);
      await writeFrame(connection.socket, { id: frame.id, ok: true, payload });
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === "INTERNAL") {
        this.#logger.error("Unhandled request error", {
          message: errorMessage(error),
          stack: errorStack(error),
          type: frame.type,
        });
      } else {
        this.#logger.debug("Handled request error", { code, type: frame.type });
      }
      await this.#respondError(connection.socket, frame.id, code, errorMessage(error));
    }
  }

  async #handleHello(connection: Connection, frame: RequestFrame): Promise<void> {
    if (frame.type !== "hello") {
      await this.#respondError(
        connection.socket,
        frame.id,
        "HANDSHAKE_REQUIRED",
        "First message must be hello",
      );
      await connection.socket.close();
      return;
    }
    const parsedHello = helloRequestSchema.safeParse(frame.payload);
    if (!parsedHello.success) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "BAD_REQUEST",
        parsedHello.error.issues.map((issue) => issue.message).join("; "),
      );
      await connection.socket.close();
      return;
    }
    const payload = parsedHello.data;
    // ADR 0003 §6: the daemon prefers the client's `protocolRange` when present, and treats a
    // bare `protocolVersion` as `{n, n}` only when it is not -- `helloRequestSchema` already
    // guarantees at least one of the two is present.
    const clientRange: ProtocolRange =
      payload.protocolRange ?? normalizeProtocolVersion(payload.protocolVersion as number);
    const negotiated = negotiateProtocolVersion(clientRange, this.#protocolRange);
    if (negotiated === undefined) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_UNSUPPORTED",
        `No overlapping protocol version: client supports ${clientRange.min}-${clientRange.max}, daemon supports ${this.#protocolRange.min}-${this.#protocolRange.max}`,
        { client: clientRange, daemon: this.#protocolRange, daemonVersion: this.options.version },
      );
      await connection.socket.close();
      return;
    }
    connection.helloReceived = true;
    connection.heartbeatCapability = payload.capabilities?.heartbeat === true;
    this.#logger.info("Connection opened", {
      clientVersion: payload.clientVersion,
      heartbeatCapability: connection.heartbeatCapability,
      protocolVersion: negotiated,
    });
    // `role` is fixed to "agent" until PR 2 resolves it from a real credential (ADR §5); the
    // reply shape carries the field now so a client can start asserting against it early.
    const reply = this.#parseOutput(
      helloReplySchema,
      {
        protocolVersion: negotiated,
        daemonProtocolRange: this.#protocolRange,
        version: this.options.version,
        role: "agent",
      },
      "hello",
    );
    await writeFrame(connection.socket, { id: frame.id, ok: true, payload: reply });
  }

  // fallow-ignore-next-line complexity -- command dispatch is intentionally centralized at the protocol boundary.
  async #handleRequest(connection: Connection, frame: RequestFrame): Promise<unknown> {
    if (frame.type !== "status.get") {
      await this.#awaitReady();
    }
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.id, frame.payload);
      case "lease.release": {
        const input = parseInput(leaseRelease.input, frame.payload);
        // Clear before the request commits so a lease-lost push (triggered by the
        // resulting lease.released event) does not also fire back at this same
        // connection for the release it just asked for itself.
        const wasHeld = connection.heldLeaseIds.delete(input.leaseId);
        try {
          await this.options.leases.release(input.leaseId, "explicit");
        } catch (error: unknown) {
          if (wasHeld) connection.heldLeaseIds.add(input.leaseId);
          throw error;
        }
        return this.#parseOutput(leaseRelease.output, { leaseId: input.leaseId }, "lease.release");
      }
      case "lease.release-all": {
        parseInput(leaseReleaseAll.input, frame.payload ?? {});
        const previouslyHeld = [...connection.heldLeaseIds];
        connection.heldLeaseIds.clear();
        try {
          const leaseIds = await this.options.leases.releaseAll("explicit");
          return this.#parseOutput(leaseReleaseAll.output, { leaseIds }, "lease.release-all");
        } catch (error: unknown) {
          for (const leaseId of previouslyHeld) connection.heldLeaseIds.add(leaseId);
          throw error;
        }
      }
      case "lease.renew": {
        const input = parseInput(leaseRenew.input, frame.payload);
        // Omitted ttlMs falls back to the lease's own mode-aware default (core's
        // `#ttlFor`) rather than always assuming detached -- substituting the detached
        // TTL here would silently shorten a held lease's hour-long backstop to 15m.
        const record = await this.options.leases.renew(input.leaseId, input.ttlMs);
        return this.#parseOutput(leaseRenew.output, record, "lease.renew");
      }
      case "lease.cancel": {
        const input = parseInput(leaseCancel.input, frame.payload ?? {});
        const requesterId = input.requesterId ?? this.options.defaultRequesterId;
        const result = await this.options.queue.cancelPending(requesterId);
        return this.#parseOutput(leaseCancel.output, { result }, "lease.cancel");
      }
      case "lease.list": {
        parseInput(leaseList.input, frame.payload ?? {});
        const leases = this.options.registry.snapshot.leases.map((lease) =>
          this.#decorateLease(lease),
        );
        return this.#parseOutput(leaseList.output, { leases }, "lease.list");
      }
      case "lease.heartbeat": {
        parseInput(leaseHeartbeat.input, frame.payload ?? {});
        if (!connection.heartbeatCapability) {
          throw new ProtocolError(
            "BAD_REQUEST",
            "Connection did not declare the heartbeat capability",
          );
        }
        const leases = await this.#heartbeatHeldLeases(connection);
        return this.#parseOutput(leaseHeartbeat.output, { leases }, "lease.heartbeat");
      }
      case "status.get": {
        parseInput(statusGet.input, frame.payload ?? {});
        return this.#parseOutput(statusGet.output, this.#status(), "status.get");
      }
      case "list.get": {
        const input = parseInput(listGet.input, frame.payload ?? {});
        return this.#parseOutput(listGet.output, this.#list(input), "list.get");
      }
      case "catalog.get": {
        const input = parseInput(catalogGet.input, frame.payload ?? {});
        const result = { platforms: await this.options.catalog.listCatalog(input.platform) };
        return this.#parseOutput(catalogGet.output, result, "catalog.get");
      }
      case "cleanup.run": {
        const input = parseInput(cleanupRun.input, frame.payload ?? {});
        const result = await this.options.reaper.run({
          dryRun: input.dryRun ?? false,
          ...(input.rule === undefined ? {} : { rule: input.rule }),
        });
        return this.#parseOutput(cleanupRun.output, result, "cleanup.run");
      }
      case "doctor.run": {
        const input = parseInput(doctorRun.input, frame.payload ?? {});
        if (this.options.doctor === undefined) throw new DoctorUnavailableError();
        const report = await this.options.doctor.reconcile({ fix: input.fix ?? false });
        return this.#parseOutput(doctorRun.output, report, "doctor.run");
      }
      case "nuke.run": {
        const input = parseInput(nukeRun.input, frame.payload ?? {});
        if (this.options.nuke === undefined) throw new NukeUnavailableError();
        const result = await this.options.nuke.run({ deleteDevices: input.deleteDevices ?? false });
        return this.#parseOutput(nukeRun.output, result, "nuke.run");
      }
      case "events.replay": {
        const input = parseInput(eventsReplay.input, frame.payload ?? {});
        const result = this.options.eventBus.replay(
          input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs },
        );
        return this.#parseOutput(eventsReplay.output, result, "events.replay");
      }
      case "events.subscribe": {
        parseInput(eventsSubscribe.input, frame.payload ?? {});
        connection.unsubscribeEvents?.();
        this.#eventSubscriptionSeq += 1;
        const subscriptionId = `sub_${this.#eventSubscriptionSeq}`;
        connection.subscriptionId = subscriptionId;
        connection.unsubscribeEvents = this.options.eventBus.subscribeAll((event) => {
          void this.#pushEvent(connection.socket, subscriptionId, event);
        });
        return this.#parseOutput(
          eventsSubscribe.output,
          { subscribed: true, subscriptionId },
          "events.subscribe",
        );
      }
      case "events.unsubscribe": {
        parseInput(eventsUnsubscribe.input, frame.payload ?? {});
        connection.unsubscribeEvents?.();
        connection.unsubscribeEvents = undefined;
        connection.subscriptionId = undefined;
        return this.#parseOutput(
          eventsUnsubscribe.output,
          { subscribed: false },
          "events.unsubscribe",
        );
      }
      case "config.get": {
        parseInput(configGet.input, frame.payload ?? {});
        return this.#parseOutput(configGet.output, this.options.config, "config.get");
      }
      // "daemon.stop" is deliberately absent from this switch: `#dispatchLine` intercepts it
      // before hello/dispatch entirely, as the frozen exception ADR §6 describes, so it never
      // reaches `#handleRequest`.
      default:
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }

  // fallow-ignore-next-line complexity -- lease payload validation and held-connection lifecycle are one transaction.
  async #requestLease(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
  ): Promise<unknown> {
    const input = parseInput(leaseRequest.input, value ?? {});
    const request: DeviceRequest = {
      model: input.model,
      platform: input.platform,
      ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
      ...(input.full ? { full: true } : {}),
    };
    const mode = input.mode ?? "held";
    const requesterId = input.requesterId ?? this.options.defaultRequesterId;
    // The request's own flag is only the input to the policy, not the final answer: `never`
    // overrides an explicit `true` (and is what should show up in the eventual "runtime
    // missing" message below), `always` grants it without the caller asking.
    const requestedAllowDownload = input.allowDownload ?? false;
    const downloadsPolicy = this.options.config.downloads.policy;
    let progressSocket: IpcConnection | undefined = connection.socket;
    const disposeProgress = () => {
      progressSocket = undefined;
    };
    connection.progressDisposers.add(disposeProgress);
    connection.progressRequesters.add(requesterId);
    let grant;
    try {
      grant = await this.options.leases.request(request, {
        allowDownload: effectiveAllowDownload(downloadsPolicy, requestedAllowDownload),
        mode,
        noWait: input.noWait ?? false,
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            void this.#pushProgress(progressSocket, requestId, progress);
          }
        },
        requesterId,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        // NOTE: `input.ttlMs` is validated by the contract (BAD_REQUEST for a held lease, via
        // `leaseRequestInputSchema`'s `superRefine`) but not forwarded here --
        // `LeaseRequestOptions` (src/core/wait-queue.ts) has no `ttlMs` field yet. Threading an
        // initial TTL for a detached lease through core (`WaitQueue`/`LeaseEngine`) is later-PR
        // plumbing, beyond this PR's "daemon validates inputs" scope -- see the PR description.
      });
    } catch (error: unknown) {
      // The driver only ever sees the clamped-to-false permission, so its own
      // RuntimeMissingError just says "missing" -- it has no way to know config is what's
      // standing between this request and success. Recover that distinction here, the one place
      // that saw both sides, rather than teaching the driver about config. Attach the suffix
      // whenever the `never` policy is active, regardless of whether this particular request
      // asked for a download: the driver's message suggests `--allow-download`, which under
      // `never` can never help, so the suffix is the correction every caller needs to see, not
      // just the ones that happened to ask. Still gated on `downloadable`: a request no download
      // could ever have fixed (out of range, an installed-but-unpaired runtime, older than the
      // download floor) must not be blamed on the download policy -- that policy was never what
      // stood between this request and success.
      if (
        downloadsPolicy === "never" &&
        error instanceof RuntimeMissingError &&
        error.downloadable
      ) {
        error.message = `${error.message} (downloads are disabled by configuration: downloads.policy is "never")`;
      }
      throw error;
    } finally {
      connection.progressDisposers.delete(disposeProgress);
      connection.progressRequesters.delete(requesterId);
      disposeProgress();
    }
    if (mode === "held" && (connection.closed || this.#stopping)) {
      await this.options.leases.release(grant.lease.id, "closed");
    } else if (mode === "held") {
      connection.heldLeaseIds.add(grant.lease.id);
    }
    return this.#parseOutput(leaseRequest.output, grant, "lease.request");
  }

  #list(input: { readonly kind?: "devices" | "leases" | "rules" | undefined }): unknown {
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
  }

  #status(): unknown {
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
      ...snapshot,
      devices: snapshot.devices.map((device) => this.#decorateDevice(device)),
      leases: snapshot.leases.map((lease) => this.#decorateLease(lease)),
      capacity: { ...capacity, global: { ...running.global, warm: warmDevices.length } },
      health: this.#health,
      queueDepth: this.options.queue.queueDepth,
    };
  }

  /**
   * Validates a handler's return value against its contract output schema before it goes on
   * the wire. A mismatch here is always a daemon-side bug (the schema or the mapping is wrong,
   * per the PR brief -- never loosen the schema to whatever happens to be emitted), so it is
   * logged at error level with the full issue list, then rethrown as a plain `Error` (maps to
   * `INTERNAL` in `errorCode`). Two things follow from throwing rather than silently coercing:
   * a unit test that asserts a happy-path response fails loudly the moment a handler and its
   * schema drift, and a production caller gets a controlled `INTERNAL` response instead of
   * either a malformed payload or an unhandled exception tearing down the connection. `.parse`
   * (not `.strict()`) is deliberately non-strict here: an additive field a handler starts
   * returning before its schema is updated to include it is silently dropped, not a failure --
   * only a missing/mistyped *declared* field is a bug worth failing loudly over.
   */
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

  /**
   * Adds a derived `lastHeartbeatAt` for held leases, without a new `LeaseRecord` field:
   * since `heartbeat()` writes through the registry, `ttlDeadline - heldTtlBackstopMs` is
   * exactly the moment of the most recent slide (or grant, if there hasn't been one yet).
   */
  #decorateLease(lease: LeaseRecord): LeaseRecord & { readonly lastHeartbeatAt?: number } {
    if (lease.mode !== "held") return lease;
    return {
      ...lease,
      lastHeartbeatAt: lease.ttlDeadline - this.options.config.lease.heldTtlBackstopMs,
    };
  }

  /**
   * Adds a derived `transitionAgeMs` for a `provisioning`/`reclaiming` device -- how long
   * it has been mid-transition, the same age Doctor compares against its stall threshold
   * (see `stalledTransitionFinding` in doctor.ts) -- so `status`/`list --devices` can show
   * it without the CLI needing its own notion of "now".
   */
  #decorateDevice(device: DeviceRecord): DeviceRecord & { readonly transitionAgeMs?: number } {
    const enteredAt = transitionEnteredAt(device);
    if (enteredAt === undefined) return device;
    return { ...device, transitionAgeMs: this.options.clock.now() - enteredAt };
  }

  /** ADR §8: `progress` carries the originating request's frame id, so a client with more than
   * one lease request in flight on the same connection can route each push to its own call. */
  async #pushProgress(
    socket: IpcConnection,
    requestId: RequestId,
    progress: LeaseProgress,
  ): Promise<void> {
    return writeFrame(socket, {
      push: "progress",
      payload: this.#parseOutput(PUSH_SCHEMAS.progress, { requestId, progress }, "push:progress"),
    });
  }

  /** ADR §8: `event` carries the subscribing connection's subscription id. */
  async #pushEvent(
    socket: IpcConnection,
    subscriptionId: string,
    event: EventEnvelope,
  ): Promise<void> {
    await writeFrame(socket, {
      push: "event",
      payload: this.#parseOutput(PUSH_SCHEMAS.event, { subscriptionId, event }, "push:event"),
    });
  }

  /**
   * Pushes `lease.heartbeat` every `lease.heartbeatIntervalMs` to every connection that
   * both declared the capability at `hello` and currently holds at least one lease.
   * Reschedules itself each tick since `Clock` has no `setInterval`.
   */
  #scheduleHeartbeatTick(): void {
    if (this.#stopping) return;
    this.#heartbeatTimer = this.options.clock.setTimer(
      this.options.config.lease.heartbeatIntervalMs,
      () => {
        this.#sendHeartbeatPushes();
        this.#scheduleHeartbeatTick();
      },
    );
  }

  #sendHeartbeatPushes(): void {
    for (const connection of this.#connections) {
      if (!connection.heartbeatCapability || connection.heldLeaseIds.size === 0) continue;
      this.#heartbeatNonce += 1;
      void this.#pushHeartbeat(connection.socket, this.#heartbeatNonce);
    }
  }

  async #pushHeartbeat(socket: IpcConnection, nonce: number): Promise<void> {
    await writeFrame(socket, {
      push: "lease.heartbeat",
      payload: this.#parseOutput(
        PUSH_SCHEMAS["lease.heartbeat"],
        { nonce },
        "push:lease.heartbeat",
      ),
    });
  }

  /**
   * Slides every lease this connection holds. A lease that raced to expiry or release
   * between the push and this pong is skipped rather than failing the whole heartbeat.
   */
  async #heartbeatHeldLeases(
    connection: Connection,
  ): Promise<Array<{ readonly leaseId: string; readonly ttlDeadline: number }>> {
    const acked: Array<{ readonly leaseId: string; readonly ttlDeadline: number }> = [];
    for (const leaseId of connection.heldLeaseIds) {
      try {
        const renewed = await this.options.leases.heartbeat(leaseId);
        acked.push({ leaseId: renewed.id, ttlDeadline: renewed.ttlDeadline });
      } catch (error: unknown) {
        if (!(error instanceof UnknownLeaseError)) throw error;
      }
    }
    return acked;
  }

  /**
   * Pushes a lease-ended fact to the connection currently holding `leaseId`, if any,
   * and stops tracking that lease as held so a later connection close does not try
   * to release it again. Reacts to the existing post-commit lease.expired /
   * lease.released facts (observer-only; no transaction waits on this).
   */
  #notifyLeaseLost(leaseId: string, deviceId: string, reason: string): void {
    for (const connection of this.#connections) {
      if (!connection.heldLeaseIds.delete(leaseId)) continue;
      void this.#pushLeaseLost(connection.socket, { deviceId, leaseId, reason });
      return;
    }
  }

  async #pushLeaseLost(
    socket: IpcConnection,
    payload: { readonly deviceId: string; readonly leaseId: string; readonly reason: string },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "lease-lost",
      payload: this.#parseOutput(PUSH_SCHEMAS["lease-lost"], payload, "push:lease-lost"),
    });
  }

  /**
   * Finds the connection currently holding `leaseId`, without touching `heldLeaseIds`.
   * Unlike `#notifyLeaseLost`, a crash/recovery notice does not end the lease -- it is
   * still held, and the connection must still release it on close -- so this is a
   * deliberate sibling rather than a shared helper `#notifyLeaseLost` could be
   * parameterised into: reusing that one here would risk someone later adding a flag
   * that forgets to keep a live lease in the set.
   */
  #connectionHolding(leaseId: string): Connection | undefined {
    for (const connection of this.#connections) {
      if (connection.heldLeaseIds.has(leaseId)) return connection;
    }
    return undefined;
  }

  /** Reacts to the post-commit `device.crash-detected` fact; observer-only, nothing awaits this. */
  #notifyDeviceUnhealthy(leaseId: string, deviceId: string): void {
    const connection = this.#connectionHolding(leaseId);
    if (connection === undefined) return;
    void this.#pushDeviceUnhealthy(connection.socket, { deviceId, leaseId, reason: "crashed" });
  }

  async #pushDeviceUnhealthy(
    socket: IpcConnection,
    payload: { readonly deviceId: string; readonly leaseId: string; readonly reason: "crashed" },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "device-unhealthy",
      payload: this.#parseOutput(
        PUSH_SCHEMAS["device-unhealthy"],
        payload,
        "push:device-unhealthy",
      ),
    });
  }

  /** Reacts to the post-commit `device.recovered` fact; observer-only, nothing awaits this. */
  #notifyDeviceRecovered(leaseId: string, deviceId: string, attempts: number): void {
    const connection = this.#connectionHolding(leaseId);
    if (connection === undefined) return;
    void this.#pushDeviceRecovered(connection.socket, { attempts, deviceId, leaseId });
  }

  async #pushDeviceRecovered(
    socket: IpcConnection,
    payload: { readonly attempts: number; readonly deviceId: string; readonly leaseId: string },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "device-recovered",
      payload: this.#parseOutput(
        PUSH_SCHEMAS["device-recovered"],
        payload,
        "push:device-recovered",
      ),
    });
  }

  async #respondError(
    socket: IpcConnection,
    id: RequestId | null,
    code: string,
    message: string,
    details?: unknown,
  ): Promise<void> {
    await writeFrame(socket, {
      error: { code, message, ...(details === undefined ? {} : { details }) },
      id,
      ok: false,
    });
  }

  #closeConnection(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.helloReceived) {
      this.#logger.info("Connection closed", { heldLeaseCount: connection.heldLeaseIds.size });
    }
    for (const disposeProgress of connection.progressDisposers) {
      disposeProgress();
    }
    connection.progressDisposers.clear();
    for (const requesterId of connection.progressRequesters) {
      void this.options.queue.detachQueuedProgress(requesterId);
    }
    connection.progressRequesters.clear();
    this.#connections.delete(connection);
    connection.unsubscribeEvents?.();
    connection.unsubscribeEvents = undefined;
    void this.#releaseHeld(connection).catch(() => undefined);
  }

  #releaseHeld(connection: Connection): Promise<void> {
    if (connection.releasing !== undefined) {
      return connection.releasing;
    }
    const leaseIds = [...connection.heldLeaseIds];
    connection.heldLeaseIds.clear();
    const releasing = Promise.all(
      leaseIds.map(async (leaseId) => {
        try {
          await this.options.leases.release(leaseId, "closed");
        } catch (error: unknown) {
          if (!(error instanceof UnknownLeaseError)) {
            throw error;
          }
        }
      }),
    ).then(() => undefined);
    connection.releasing = releasing;
    void releasing.then(
      () => this.#clearReleasing(connection, releasing),
      () => this.#clearReleasing(connection, releasing),
    );
    return releasing;
  }

  #clearReleasing(connection: Connection, releasing: Promise<void>): void {
    if (connection.releasing === releasing) {
      connection.releasing = undefined;
    }
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Thrown to a parked request when startup convergence rejected; see `#awaitReady`. */
class StartupFailedError extends Error {
  constructor() {
    super("Daemon failed to start");
    this.name = "StartupFailedError";
  }
}

/**
 * `doctor.run`/`nuke.run` used to throw a plain `new Error("... is unavailable")` when their
 * optional collaborator was never wired up, which `errorCode()` had no choice but to map to
 * `INTERNAL` -- indistinguishable from a real bug. Real, typed errors give these their own
 * codes in the contract's closed set (`DOCTOR_UNAVAILABLE`/`NUKE_UNAVAILABLE`), per ADR §7 ("one
 * error class, closed codes").
 */
class DoctorUnavailableError extends Error {
  constructor() {
    super("Doctor is unavailable");
    this.name = "DoctorUnavailableError";
  }
}

class NukeUnavailableError extends Error {
  constructor() {
    super("Nuke is unavailable");
    this.name = "NukeUnavailableError";
  }
}

/** Parses a request payload through its contract input schema, translating a validation
 * failure into the daemon's own `ProtocolError("BAD_REQUEST", ...)` rather than letting a raw
 * `ZodError` escape (its shape is not part of the wire contract). */
function parseInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const description = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
  throw new ProtocolError("BAD_REQUEST", description);
}

// fallow-ignore-next-line complexity -- preserves stable protocol error mapping.
function errorCode(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.code;
  }
  if (error instanceof NoCapacityError) {
    return "NO_CAPACITY";
  }
  if (error instanceof QueueTimeoutError) {
    return "QUEUE_TIMEOUT";
  }
  if (error instanceof RequesterAlreadyLeasedError) {
    return "REQUESTER_ALREADY_LEASED";
  }
  if (error instanceof NoDriverError) {
    return "NO_DRIVER";
  }
  if (error instanceof RuntimeMissingError) {
    return "RUNTIME_MISSING";
  }
  if (error instanceof UnknownModelError) {
    return "UNKNOWN_MODEL";
  }
  if (error instanceof InsufficientDiskSpaceError) {
    return "INSUFFICIENT_DISK_SPACE";
  }
  if (error instanceof LicenseNotAcceptedError) {
    return "LICENSE_NOT_ACCEPTED";
  }
  if (error instanceof UnknownLeaseError) {
    return "UNKNOWN_LEASE";
  }
  if (error instanceof StartupFailedError) {
    return "DAEMON_STARTUP_FAILED";
  }
  if (error instanceof DoctorUnavailableError) {
    return "DOCTOR_UNAVAILABLE";
  }
  if (error instanceof NukeUnavailableError) {
    return "NUKE_UNAVAILABLE";
  }
  return "INTERNAL";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function writeFrame(socket: IpcConnection, frame: unknown): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return socket.write(serializeFrame(frame));
}
