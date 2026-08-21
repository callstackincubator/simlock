import { type EventBus, type EventEnvelope } from "../bus/index.js";
import {
  type Config,
  type DeviceRecord,
  type DeviceRequest,
  type LeaseProgress,
  type LeaseRecord,
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
import {
  DAEMON_PROTOCOL_VERSION,
  parseRequestFrame,
  serializeFrame,
  type RequestFrame,
} from "../daemon-protocol/index.js";
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
  readonly protocolVersion?: number;
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
}

type DaemonHealth = "starting" | "running" | "failed";

export class DaemonServer {
  readonly #connections = new Set<Connection>();
  readonly #protocolVersion: number;
  readonly #unsubscribeLeaseLost: Array<() => void> = [];
  readonly #logger: Logger;
  #heartbeatTimer: TimerHandle | undefined;
  #heartbeatNonce = 0;
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
    this.#protocolVersion = options.protocolVersion ?? DAEMON_PROTOCOL_VERSION;
    this.#logger = options.logger ?? new NoopLogger();
  }

  // fallow-ignore-next-line unused-class-member -- retained as a daemon compatibility facade.
  get socketPath(): string {
    return this.options.host.endpoint;
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
      protocolVersion: this.#protocolVersion,
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
      if (frame.type === "daemon.stop") {
        void this.stop("requested");
      }
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
    const payload = objectPayload(frame.payload);
    if (typeof payload.clientVersion !== "string") {
      await this.#respondError(
        connection.socket,
        frame.id,
        "BAD_REQUEST",
        "hello requires a clientVersion string",
      );
      await connection.socket.close();
      return;
    }
    if (payload.protocolVersion !== this.#protocolVersion) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_MISMATCH",
        `Protocol version ${String(payload.protocolVersion)} is not supported`,
      );
      await connection.socket.close();
      return;
    }
    connection.helloReceived = true;
    connection.heartbeatCapability = isObject(payload.capabilities)
      ? payload.capabilities.heartbeat === true
      : false;
    this.#logger.info("Connection opened", {
      clientVersion: payload.clientVersion,
      heartbeatCapability: connection.heartbeatCapability,
    });
    await writeFrame(connection.socket, {
      id: frame.id,
      ok: true,
      payload: { protocolVersion: this.#protocolVersion, version: this.options.version },
    });
  }

  // fallow-ignore-next-line complexity -- command dispatch is intentionally centralized at the protocol boundary.
  async #handleRequest(connection: Connection, frame: RequestFrame): Promise<unknown> {
    if (frame.type !== "status.get") {
      await this.#awaitReady();
    }
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.payload);
      case "lease.release": {
        const leaseId = requiredString(objectPayload(frame.payload), "leaseId");
        // Clear before the request commits so a lease-lost push (triggered by the
        // resulting lease.released event) does not also fire back at this same
        // connection for the release it just asked for itself.
        const wasHeld = connection.heldLeaseIds.delete(leaseId);
        try {
          await this.options.leases.release(leaseId, "explicit");
        } catch (error: unknown) {
          if (wasHeld) connection.heldLeaseIds.add(leaseId);
          throw error;
        }
        return { leaseId };
      }
      case "lease.release-all": {
        const previouslyHeld = [...connection.heldLeaseIds];
        connection.heldLeaseIds.clear();
        try {
          const leaseIds = await this.options.leases.releaseAll("explicit");
          return { leaseIds };
        } catch (error: unknown) {
          for (const leaseId of previouslyHeld) connection.heldLeaseIds.add(leaseId);
          throw error;
        }
      }
      case "lease.renew": {
        const payload = objectPayload(frame.payload);
        const leaseId = requiredString(payload, "leaseId");
        // Omitted ttlMs falls back to the lease's own mode-aware default (core's
        // `#ttlFor`) rather than always assuming detached -- substituting the detached
        // TTL here would silently shorten a held lease's hour-long backstop to 15m.
        const ttlMs = payload.ttlMs === undefined ? undefined : requiredNumber(payload, "ttlMs");
        return this.options.leases.renew(leaseId, ttlMs);
      }
      case "lease.heartbeat": {
        if (!connection.heartbeatCapability) {
          throw new ProtocolError(
            "BAD_REQUEST",
            "Connection did not declare the heartbeat capability",
          );
        }
        return { leases: await this.#heartbeatHeldLeases(connection) };
      }
      case "status.get":
        return this.#status();
      case "list.get":
        return this.#list(objectPayload(frame.payload));
      case "catalog.get": {
        const payload = objectPayload(frame.payload);
        return { platforms: await this.options.catalog.listCatalog(optionalPlatform(payload)) };
      }
      case "cleanup.run": {
        const payload = objectPayload(frame.payload);
        return this.options.reaper.run({
          dryRun: optionalBoolean(payload, "dryRun") ?? false,
          ...(typeof payload.rule === "string" ? { rule: payload.rule } : {}),
        });
      }
      case "doctor.run": {
        const payload = objectPayload(frame.payload);
        if (this.options.doctor === undefined) throw new Error("Doctor is unavailable");
        return this.options.doctor.reconcile({ fix: optionalBoolean(payload, "fix") ?? false });
      }
      case "nuke.run": {
        const payload = objectPayload(frame.payload);
        if (this.options.nuke === undefined) throw new Error("Nuke is unavailable");
        return this.options.nuke.run({
          deleteDevices: optionalBoolean(payload, "deleteDevices") ?? false,
        });
      }
      case "events.replay": {
        const payload = objectPayload(frame.payload);
        return this.options.eventBus.replay(
          typeof payload.sinceTs === "number" ? { sinceTs: payload.sinceTs } : {},
        );
      }
      case "events.subscribe":
        connection.unsubscribeEvents?.();
        connection.unsubscribeEvents = this.options.eventBus.subscribeAll((event) => {
          void this.#pushEvent(connection.socket, event);
        });
        return { subscribed: true };
      case "events.unsubscribe":
        connection.unsubscribeEvents?.();
        connection.unsubscribeEvents = undefined;
        return { subscribed: false };
      case "config.get":
        return this.options.config;
      case "daemon.stop":
        return { stopping: true };
      default:
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }

  // fallow-ignore-next-line complexity -- lease payload validation and held-connection lifecycle are one transaction.
  async #requestLease(connection: Connection, value: unknown): Promise<unknown> {
    const payload = objectPayload(value);
    const requestPayload = isObject(payload.request) ? payload.request : payload;
    const osVersion = optionalString(requestPayload, "osVersion", "os");
    const request: DeviceRequest = {
      model: requiredString(requestPayload, "model", "device"),
      platform: requiredPlatform(requestPayload),
      ...(osVersion === undefined ? {} : { osVersion }),
    };
    const mode = payload.mode === "detached" ? "detached" : "held";
    const requesterId = optionalString(payload, "requesterId") ?? this.options.defaultRequesterId;
    let progressSocket: IpcConnection | undefined = connection.socket;
    const disposeProgress = () => {
      progressSocket = undefined;
    };
    connection.progressDisposers.add(disposeProgress);
    connection.progressRequesters.add(requesterId);
    let grant;
    try {
      grant = await this.options.leases.request(request, {
        allowDownload: optionalBoolean(payload, "allowDownload") ?? false,
        mode,
        noWait: optionalBoolean(payload, "noWait") ?? false,
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            void this.#pushProgress(progressSocket, progress);
          }
        },
        requesterId,
        ...(typeof payload.timeoutMs === "number" ? { timeoutMs: payload.timeoutMs } : {}),
      });
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
    return grant;
  }

  #list(payload: Record<string, unknown>): unknown {
    const snapshot = this.options.registry.snapshot;
    switch (payload.kind) {
      case "leases":
        return snapshot.leases.map((lease) => this.#decorateLease(lease));
      case "rules":
        return this.options.reaper.rules;
      case "devices":
      case undefined:
        return snapshot.devices.map((device) => this.#decorateDevice(device));
      default:
        throw new ProtocolError("BAD_REQUEST", "list kind must be devices, leases, or rules");
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
          limit: this.options.config.limits[platform].maxDevices,
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

  async #pushProgress(socket: IpcConnection, progress: LeaseProgress): Promise<void> {
    return writeFrame(socket, {
      push: "progress",
      payload: progress,
    });
  }

  async #pushEvent(socket: IpcConnection, event: EventEnvelope): Promise<void> {
    await writeFrame(socket, { push: "event", payload: event });
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
    await writeFrame(socket, { push: "lease.heartbeat", payload: { nonce } });
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
    await writeFrame(socket, { push: "lease-lost", payload });
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
    await writeFrame(socket, { push: "device-unhealthy", payload });
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
    await writeFrame(socket, { push: "device-recovered", payload });
  }

  async #respondError(
    socket: IpcConnection,
    id: RequestId | null,
    code: string,
    message: string,
  ): Promise<void> {
    await writeFrame(socket, { error: { code, message }, id, ok: false });
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

function objectPayload(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ProtocolError("BAD_REQUEST", "Payload must be an object");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, ...keys: string[]): string {
  const value = optionalString(payload, ...keys);
  if (value === undefined) {
    throw new ProtocolError("BAD_REQUEST", `Missing required string: ${keys[0]}`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError("BAD_REQUEST", `Missing required number: ${key}`);
  }
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ProtocolError("BAD_REQUEST", `Expected boolean: ${key}`);
  }
  return value;
}

function requiredPlatform(payload: Record<string, unknown>): "ios" | "android" {
  const platform = payload.platform;
  if (platform !== "ios" && platform !== "android") {
    throw new ProtocolError("BAD_REQUEST", "platform must be ios or android");
  }
  return platform;
}

function optionalPlatform(payload: Record<string, unknown>): "ios" | "android" | undefined {
  if (payload.platform === undefined) {
    return undefined;
  }
  return requiredPlatform(payload);
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
  if (error instanceof UnknownLeaseError) {
    return "UNKNOWN_LEASE";
  }
  if (error instanceof StartupFailedError) {
    return "DAEMON_STARTUP_FAILED";
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
