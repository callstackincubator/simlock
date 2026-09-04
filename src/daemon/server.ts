import { z } from "zod";

import { type EventBus, type EventEnvelope } from "../bus/index.js";
import {
  type Config,
  type LeaseProgress,
  type Registry,
  type CleanupReaper,
  type Doctor,
  type DriverRejection,
  type LeaseHealthMonitor,
  NoDriverError,
  type Nuke,
  UnknownLeaseError,
  UnknownPassthroughToolError,
} from "../core/index.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseCommands,
  PassthroughResolver,
  QueueControl,
} from "../core/lease-ports.js";
import type { Clock, IpcConnection, Logger, TimerHandle } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { parseRequestFrame, serializeFrame, type RequestFrame } from "../daemon-protocol/index.js";
import {
  helloRequestSchema,
  helloReplySchema,
  leaseRelease,
  leaseRequest,
  negotiateProtocolVersion,
  normalizeProtocolVersion,
  PROTOCOL_VERSION_RANGE,
  PUSH_SCHEMAS,
  type OperationName,
  type OPERATIONS,
  type ProtocolRange,
  type Role,
} from "../contract/index.js";
import type { ConnectionHost } from "./connection-host.js";
import type { TokenStore } from "../http/token-store.js";
import { Dispatcher, DispatchError, type DispatchSession } from "./dispatcher.js";
import { resolveAgentRole, type SessionRoleResolver } from "./session.js";
import type { AdminSecretManager } from "./admin-secret.js";
import { OwnerRoutedFactBus, type OwnerRoutedFacts } from "./owner-routed-facts.js";
import { classifyError, StartupFailedError } from "./error-code.js";

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
  /** ADR 0003 §4: fixed at `hello` for the connection's lifetime. `principal` defaults to
   * `options.defaultRequesterId` when `hello` omits one (today's CLI/MCP -- PR 4 moves them
   * onto the typed client, which always sends one). `role` comes from `options.resolveRole`,
   * the seam PR 2's credential handshake replaces -- see `session.ts`. */
  principal: string;
  role: Role;
  /**
   * Lease ids this connection is *currently* explicitly releasing (`lease.release`/
   * `lease.release-all`), added right before the dispatched call and consumed by
   * `#notifyLeaseLost`. ADR §8 says a client "never fires `onLeaseLost` for a release the same
   * client asked for" -- stated as the *client's* dedup rule (a future PR), but with pushes now
   * owner-routed to every connection sharing a principal (not just the single held-lease
   * holder), the daemon can no longer rely on `heldLeaseIds` membership alone to skip the
   * asking connection: that would also wrongly skip every *other* live connection with the
   * same principal, which is exactly the fan-out this PR adds. So the daemon still suppresses
   * the self-push for the one connection that asked, by connection identity rather than by
   * principal, and lets every other owning connection's push through undisturbed.
   */
  readonly selfInitiatedReleases: Set<string>;
  /** Set by `#handleHello` only when this connection's `hello` failed protocol-version
   * negotiation (ADR 0003 §6). `principal`/`role` are still resolved and fixed as normal --
   * the frozen exception is scoped to the protocol-version gate, not to authentication or role
   * (see the comment on `#dispatchLine`'s `daemon.stop` handling). While set, every operation on
   * this connection except `daemon.stop` is refused by replaying this same error, so a client
   * whose range does not overlap the daemon's still learns why on every attempt, not just the
   * first. */
  protocolMismatch: { readonly message: string; readonly details: unknown } | undefined;
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
  /**
   * Platforms whose driver refused to start. The daemon serves without them rather than
   * refusing to come up (safety rule 9), so the refusal has to be visible somewhere: one
   * event each lands in the ring buffer here, and `Doctor` reports the same list.
   */
  readonly driverRejections?: readonly DriverRejection[];
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
  /** Builds the scoped command behind `simlock simctl` / `simlock adb`; absent in tests that never use them. */
  readonly passthrough?: PassthroughResolver;
  readonly registry: Registry;
  /** ADR 0003 §11: threaded straight into the `Dispatcher` for `token.create|list|revoke`. */
  readonly tokens?: TokenStore;
  readonly version: string;
  /** ADR §5's seam (see `session.ts`): resolves a session's role from `hello`'s payload.
   * Defaults to `resolveAgentRole` (every session is "agent") -- PR 2's credential handshake
   * supplies a real resolver here without changing anything else in this class. */
  readonly resolveRole?: SessionRoleResolver;
  /**
   * ADR §5's per-start admin secret. Undefined is a legitimate default for tests that don't
   * exercise the admin handshake at all -- `start()`/`#stop()` simply skip the persist/remove
   * calls below when it is absent, same style as `doctor`/`nuke`.
   */
  readonly adminSecret?: AdminSecretManager;
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
  /**
   * Releases what the daemon holds beyond its own state on shutdown: timers the lease
   * subsystem armed (quarantine retries), and every driver's own external resources.
   * Awaited, because a driver's release is asynchronous and a stop that returned before it
   * finished would report a shutdown that had not happened.
   */
  readonly dispose?: () => void | Promise<void>;
  /**
   * Stops an auxiliary frontend (today: the HTTP gateway's listener, started only after
   * `start()` resolves -- see `main.ts`) before anything else in `stop()` runs, so no
   * request arriving through it can ever observe a stopping engine. A no-op default when
   * no auxiliary frontend is running.
   */
  readonly stopAuxiliary?: () => Promise<void>;
  /**
   * ADR 0003 §2's "an HTTP request during startup now waits like a socket request instead of
   * being refused" needs the HTTP gateway actually listening *before* convergence finishes --
   * otherwise there is nothing for a request to park against, it just gets connection-refused
   * the way it always did. Called synchronously right after `#readyPromise` is assigned (so any
   * request `dispatch()` serves as a result of this callback already parks correctly) and after
   * the socket claim and the admin-secret write, but *before* awaiting convergence -- an
   * auxiliary frontend started from here must not itself assume convergence is done. A no-op
   * default leaves today's behaviour (no auxiliary frontend at all) unchanged.
   */
  readonly onSocketClaimed?: () => void;
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
  readonly #dispatcher: Dispatcher;
  readonly #resolveRole: SessionRoleResolver;
  readonly #ownerRoutedFacts: OwnerRoutedFactBus;

  constructor(private readonly options: DaemonServerOptions) {
    this.#protocolRange =
      options.protocolVersion === undefined
        ? PROTOCOL_VERSION_RANGE
        : normalizeProtocolVersion(options.protocolVersion);
    this.#logger = options.logger ?? new NoopLogger();
    this.#resolveRole = options.resolveRole ?? resolveAgentRole;
    // ADR §8: the same translation `#notifyLeaseLost`/`#notifyDeviceUnhealthy`/
    // `#notifyDeviceRecovered` below route from is what the HTTP gateway's `LeaseNoticeBuffer`
    // consumes too (see `ownerRoutedFacts` getter and `main.ts`) -- one bus subscription
    // per raw event, not one per consumer.
    this.#ownerRoutedFacts = new OwnerRoutedFactBus(options.eventBus, options.registry);
    this.#dispatcher = new Dispatcher({
      awaitReady: () => this.#awaitReady(),
      capacity: options.capacity,
      catalog: options.catalog,
      clock: options.clock,
      config: options.config,
      ...(options.doctor === undefined ? {} : { doctor: options.doctor }),
      eventBus: options.eventBus,
      health: () => this.#health,
      leases: options.leases,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.nuke === undefined ? {} : { nuke: options.nuke }),
      queue: options.queue,
      reaper: options.reaper,
      registry: options.registry,
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    });
  }

  // fallow-ignore-next-line unused-class-member -- retained as a daemon compatibility facade.
  get socketPath(): string {
    return this.options.host.endpoint;
  }

  /** Public read of `#health`, kept for tests and any future auxiliary frontend that needs it without becoming a privileged internal itself. */
  // fallow-ignore-next-line unused-class-member -- public surface exercised directly by server.test.ts; `status.get` itself reads `#health` through the dispatcher's own `health()` closure, not this getter.
  get health(): DaemonHealth {
    return this.#health;
  }

  /**
   * ADR 0003 §2: "the HTTP app ... calls the same dispatcher in-process. Nothing routes HTTP
   * through the loopback socket; the parity comes from the shared dispatcher, not from a
   * shared wire." This is that seam -- the one privileged thing an in-process auxiliary
   * frontend (today: `createHttpApp`, see `main.ts`) is allowed to reach into `DaemonServer`
   * for, so that it gets the exact same input parsing, role check, `authorize` hook, and
   * startup-readiness parking as every socket request, from the exact same `Dispatcher`
   * instance -- not a second one constructed with equivalent-looking options.
   */
  /** Shared with the HTTP gateway (`main.ts`) so its `LeaseNoticeBuffer` consumes the same
   * owner-routed facts this class's own socket pushes do, instead of subscribing to the raw
   * event bus a second time -- see `owner-routed-facts.ts`'s module doc. */
  get ownerRoutedFacts(): OwnerRoutedFacts {
    return this.#ownerRoutedFacts;
  }

  dispatch<Op extends OperationName>(
    operation: Op,
    input: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    // Mirrors the socket path's `#stopping` -> `DAEMON_STOPPING` gate in `#dispatchLine` (just
    // above the `#stopping` check there), so every transport that calls this method -- not only
    // the socket -- shares it. Without this, a caller that reaches the dispatcher directly (the
    // HTTP gateway; review finding S5) could have a request accepted *during* `#stop()`'s
    // window (after `stopAuxiliary()` has been awaited, but the auxiliary frontend's own
    // in-flight request already parked past this check) run against an engine `#stop()` is
    // concurrently tearing down or has already disposed. `daemon.stop` itself never reaches
    // this method (`DaemonServer#dispatchLine` handles it directly, ahead of this gate, per
    // ADR §6) so the frozen-exception behaviour is unaffected.
    if (this.#stopping) {
      return Promise.reject(new DispatchError("DAEMON_STOPPING", "Daemon is stopping"));
    }
    return this.#dispatcher.dispatch(operation, input, session);
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
    // ADR §5: written only after the socket claim above has succeeded -- a daemon that loses
    // the start race throws out of `host.start()` and never reaches this line, so it never
    // touches `admin.token`. Awaited before convergence starts (not raced with it): the file
    // landing is not itself gated on convergence -- `hello` already verifies the in-memory
    // hash regardless -- but there is no reason to let two startup-time writes race each other
    // for no benefit.
    await this.options.adminSecret?.persist();
    const readyPromise = this.#converge();
    this.#readyPromise = readyPromise;
    // See `onSocketClaimed`'s doc: fired only after `#readyPromise` is assigned, so a request
    // the auxiliary frontend starts serving as an immediate result of this call already parks
    // on it correctly via `#awaitReady()`.
    this.options.onSocketClaimed?.();
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

    // Convergence succeeded, but a `stop()` may have run to completion while it was in
    // flight -- `daemon.stop` is accepted during startup (see `#dispatchLine`), and an
    // auxiliary frontend that fails to start asks for a stop of its own. Everything below
    // this point arms live machinery: it subscribes to the fact bus, emits `daemon.started`,
    // schedules the heartbeat tick, and starts the health monitor. Running any of that
    // against an already-disposed engine would leave timers armed on a dead daemon and would
    // emit `daemon.started` after `daemon.stopping` -- a fact that is not true when emitted,
    // which `docs/agent-rules/events.md` rule 3 forbids. Bail out instead; the stop that
    // already ran owns the teardown, so there is nothing left for this call to undo.
    if (this.#stopping) {
      this.#logger.info("Daemon converged after a stop was requested; not arming", {
        socketPath: this.options.host.endpoint,
      });
      return;
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
      this.#ownerRoutedFacts.subscribe((fact) => {
        switch (fact.type) {
          case "lease-lost":
            this.#notifyLeaseLost(fact.leaseId, fact.deviceId, fact.reason, fact.ownerId);
            return;
          case "device-unhealthy":
            this.#notifyDeviceUnhealthy(fact.leaseId, fact.deviceId, fact.ownerId);
            return;
          case "device-recovered":
            this.#notifyDeviceRecovered(fact.leaseId, fact.deviceId, fact.attempts, fact.ownerId);
            return;
        }
      }),
    );

    this.options.eventBus.emit(
      "daemon.started",
      { configSnapshot: this.options.config, version: this.options.version },
      "daemon",
    );
    // After `daemon.started`, because these are facts about the daemon that just started
    // and a subscriber reading the buffer in order should see it come up first.
    for (const rejection of this.options.driverRejections ?? []) {
      // No assertion: `DriverRejection` pairs each event name with that event's own
      // payload, so the contract is checked where the driver module builds the refusal
      // rather than being taken on trust here, one step from the ring buffer.
      this.options.eventBus.emit(rejection.event, rejection.payload, "daemon");
    }
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
    this.#ownerRoutedFacts.dispose();
    this.options.reaper.dispose();
    this.options.healthMonitor?.dispose();
    await Promise.all([...this.#connections].map((connection) => this.#releaseHeld(connection)));
    // Those releases only commit the registry half and hand the purge off; draining it
    // here keeps `daemon stop` finishing on a settled pool, as it did when the reclaim
    // was inline. Disposal follows rather than precedes it, so a retry timer armed by a
    // reclaim that settles into quarantine is still cancelled.
    await this.options.settle?.();
    await this.options.dispose?.();
    for (const connection of this.#connections) {
      await connection.socket.close();
    }
    await this.options.host.stop();
    // ADR §5: removed on graceful stop, mirroring the socket file itself (`host.stop()` just
    // above). A daemon that never persisted it (lost the start race, see `start()`) has no
    // adminSecret to remove -- `#stop()` on the loser's own `DaemonServer` instance is never
    // reached, since that instance's `start()` already threw.
    await this.options.adminSecret?.remove();
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
      // Overwritten by `#handleHello` before any dispatched request can read them -- every
      // path that reaches `#handleRequest` has `connection.helloReceived === true` by
      // construction (`#dispatchLine` routes to `#handleHello` until then).
      principal: "",
      role: "agent",
      progressDisposers: new Set(),
      progressRequesters: new Set(),
      protocolMismatch: undefined,
      selfInitiatedReleases: new Set(),
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

  // fallow-ignore-next-line complexity -- frame parsing, the handshake gate, the daemon.stop frozen exception (ADR §6) and its role check, the protocol-mismatch gate, and the stopping gate are one sequential ordering contract; splitting it would scatter early-returns that must stay in this order.
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

    // `daemon.stop` is a frozen exception (ADR 0003 §6), but only with respect to the
    // *protocol-version* gate: "the daemon accepts it at any protocol version it has ever
    // spoken". It is not frozen with respect to authentication or role -- §3's operation matrix
    // assigns `daemon.stop` role `admin` like any other admin operation, and the ADR's Context
    // section names exactly this gap ("Any local connection can release any lease, nuke, or
    // stop the daemon") as the defect being fixed. So this still requires a completed,
    // successfully authenticated handshake (guaranteed by `connection.helloReceived` above --
    // a rejected credential never reaches here, see `#handleHello`) and the resolved role being
    // `admin`, but -- unlike every other operation -- it is checked here, ahead of the
    // `protocolMismatch` and `#stopping` gates below, so it stays reachable: during a version
    // mismatch (`npm upgrade` against a still-running old daemon with leases held -- see §6's
    // "the client never restarts the daemon on mismatch") and while the daemon is already
    // `#stopping`. It is intentionally idempotent: `stop()` itself dedups concurrent callers via
    // `#stopPromise`, so a second `daemon.stop` here just gets the same success reply again.
    if (frame.type === "daemon.stop") {
      if (connection.role !== "admin") {
        await this.#respondError(
          connection.socket,
          frame.id,
          "FORBIDDEN",
          "Operation daemon.stop requires role admin",
        );
        return;
      }
      await writeFrame(connection.socket, { id: frame.id, ok: true, payload: { stopping: true } });
      void this.stop("requested");
      return;
    }

    if (connection.protocolMismatch) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_UNSUPPORTED",
        connection.protocolMismatch.message,
        connection.protocolMismatch.details,
      );
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
      await this.#respondError(connection.socket, frame.id, code, this.#describeError(error));
    }
  }

  /**
   * A `NO_DRIVER` for a platform whose driver refused to start says nothing on its own:
   * it reads identically to "this host has no Xcode". Safety rule 9 promises Simlock
   * reports *why* a platform is missing, so the refusal's own one-liner travels with the
   * error on both paths a user meets it: leasing, and the `simlock simctl` / `simlock adb`
   * wrapper, whose bare "No driver provides a adb passthrough" reads as a missing SDK and
   * sends the operator off to install one instead of at the port conflict that caused it.
   */
  #describeError(error: unknown): string {
    const message = errorMessage(error);
    const rejection = this.#rejectionFor(error);
    return rejection === undefined ? message : `${message} (${rejection.summary})`;
  }

  #rejectionFor(error: unknown): DriverRejection | undefined {
    const rejections = this.options.driverRejections ?? [];
    if (error instanceof NoDriverError) {
      return rejections.find((candidate) => candidate.platform === error.platform);
    }
    if (error instanceof UnknownPassthroughToolError) {
      return rejections.find((candidate) => candidate.passthroughTool === error.tool);
    }
    return undefined;
  }

  // fallow-ignore-next-line complexity -- handshake validation, version negotiation, and role resolution are one sequential gate; splitting it would scatter the early-return contract.
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
    // ADR §5's seam: `#resolveRole` is `resolveAgentRole` (always "agent") until PR 2 supplies
    // a real credential-checking resolver -- see `session.ts`. A resolver that rejects a bad
    // credential throws here, before `connection.helloReceived` is ever set, which is why this
    // whole block is wrapped: nothing after it should be able to run for a rejected `hello` --
    // including the version-mismatch path just below. Credential verification and role
    // resolution run *before* the version check, and independently of its outcome: ADR §6's
    // frozen exception exempts `daemon.stop` from the protocol-version gate only, never from
    // authentication, so a wrong credential must fail the handshake outright here regardless of
    // whether the versions would otherwise have matched.
    let role: Role;
    try {
      role = await this.#resolveRole.resolve({
        ...(payload.principal === undefined ? {} : { principal: payload.principal }),
        ...(payload.credential === undefined ? {} : { credential: payload.credential }),
      });
    } catch (error: unknown) {
      await this.#respondError(connection.socket, frame.id, errorCode(error), errorMessage(error));
      await connection.socket.close();
      return;
    }
    connection.heartbeatCapability = payload.capabilities?.heartbeat === true;
    // ADR §4: the principal is fixed for the connection's lifetime from here on. Falls back to
    // `defaultRequesterId` when `hello` omits one -- today's CLI/MCP frontends don't send a
    // principal yet (PR 4 moves them onto the typed client, which always will).
    connection.principal = payload.principal ?? this.options.defaultRequesterId;
    connection.role = role;
    if (negotiated === undefined) {
      const details = {
        client: clientRange,
        daemon: this.#protocolRange,
        daemonVersion: this.options.version,
      };
      const message = `No overlapping protocol version: client supports ${clientRange.min}-${clientRange.max}, daemon supports ${this.#protocolRange.min}-${this.#protocolRange.max}`;
      // `helloReceived` is still set: the handshake completed (credential verified, role
      // resolved) even though negotiation failed. `protocolMismatch` is what `#dispatchLine`
      // checks to refuse every subsequent operation except `daemon.stop` with this same error
      // (ADR §6). The socket is deliberately left open -- closing it here is what today's bug
      // fixes: an admin client whose range does not overlap the daemon's must still be able to
      // send `daemon.stop` on this connection instead of restarting the daemon (§6: "the client
      // never restarts the daemon on mismatch").
      connection.helloReceived = true;
      connection.protocolMismatch = { message, details };
      this.#logger.info("Connection opened with unsupported protocol version", {
        clientVersion: payload.clientVersion,
        principal: connection.principal,
        role: connection.role,
      });
      await this.#respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_UNSUPPORTED",
        message,
        details,
      );
      return;
    }
    connection.helloReceived = true;
    this.#logger.info("Connection opened", {
      clientVersion: payload.clientVersion,
      heartbeatCapability: connection.heartbeatCapability,
      principal: connection.principal,
      protocolVersion: negotiated,
      role: connection.role,
    });
    const reply = this.#parseOutput(
      helloReplySchema,
      {
        protocolVersion: negotiated,
        daemonProtocolRange: this.#protocolRange,
        version: this.options.version,
        role: connection.role,
        // ADR §4: report the resolved principal back -- see `helloReplySchema`'s comment. Read
        // from `connection.principal`, set a few lines above from `payload.principal` or the
        // daemon's own default, so this is always the same value every subsequent dispatched
        // request is authorized against.
        principal: connection.principal,
      },
      "hello",
    );
    await writeFrame(connection.socket, { id: frame.id, ok: true, payload: reply });
  }

  /**
   * The request switch that used to live here moved to `Dispatcher` (ADR §2): this method now
   * only does what the ADR says stays with `DaemonServer` around the shared `dispatch()` call --
   * held-lease tracking (`lease.request`/`lease.release`/`lease.release-all`) and building the
   * per-call `DispatchSession` (ADR §2/§4) from this connection's fixed principal/role plus
   * whatever is call-specific (progress delivery, event-subscription management).
   */
  // fallow-ignore-next-line complexity -- held-lease bookkeeping around each dispatched operation is one transaction per case.
  async #handleRequest(connection: Connection, frame: RequestFrame): Promise<unknown> {
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.id, frame.payload);
      case "lease.release": {
        const input = parseInput(leaseRelease.input, frame.payload);
        // Clear before the request commits so held-lease bookkeeping does not try to release
        // this lease again on a later connection close. Marked in `selfInitiatedReleases` too,
        // for `#notifyLeaseLost` to suppress the self-push -- see that set's comment.
        const wasHeld = connection.heldLeaseIds.delete(input.leaseId);
        connection.selfInitiatedReleases.add(input.leaseId);
        try {
          return await this.#dispatcher.dispatch(
            "lease.release",
            frame.payload,
            this.#session(connection),
          );
        } catch (error: unknown) {
          if (wasHeld) connection.heldLeaseIds.add(input.leaseId);
          throw error;
        } finally {
          connection.selfInitiatedReleases.delete(input.leaseId);
        }
      }
      case "lease.release-all": {
        const previouslyHeld = [...connection.heldLeaseIds];
        connection.heldLeaseIds.clear();
        for (const leaseId of previouslyHeld) connection.selfInitiatedReleases.add(leaseId);
        try {
          return await this.#dispatcher.dispatch(
            "lease.release-all",
            frame.payload ?? {},
            this.#session(connection),
          );
        } catch (error: unknown) {
          for (const leaseId of previouslyHeld) connection.heldLeaseIds.add(leaseId);
          throw error;
        } finally {
          for (const leaseId of previouslyHeld) connection.selfInitiatedReleases.delete(leaseId);
        }
      }
      case "lease.renew":
        return this.#dispatcher.dispatch("lease.renew", frame.payload, this.#session(connection));
      case "lease.cancel":
        return this.#dispatcher.dispatch(
          "lease.cancel",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "lease.list":
        return this.#dispatcher.dispatch(
          "lease.list",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "lease.heartbeat":
        return this.#dispatcher.dispatch(
          "lease.heartbeat",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "status.get":
        return this.#dispatcher.dispatch(
          "status.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "list.get":
        return this.#dispatcher.dispatch(
          "list.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "catalog.get":
        return this.#dispatcher.dispatch(
          "catalog.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "cleanup.run":
        return this.#dispatcher.dispatch(
          "cleanup.run",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "doctor.run":
        return this.#dispatcher.dispatch(
          "doctor.run",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "nuke.run":
        return this.#dispatcher.dispatch(
          "nuke.run",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "events.replay":
        return this.#dispatcher.dispatch(
          "events.replay",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "events.subscribe":
        return this.#dispatcher.dispatch(
          "events.subscribe",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "events.unsubscribe":
        return this.#dispatcher.dispatch(
          "events.unsubscribe",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "driver.passthrough":
        // Resolution only: the daemon never runs the command. Spawning it here would attach
        // a user's interactive `adb shell` to the daemon's stdio, and the CLI is the process
        // that actually has a terminal.
        return this.#dispatcher.dispatch(
          "driver.passthrough",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "config.get":
        return this.#dispatcher.dispatch(
          "config.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "token.create":
        return this.#dispatcher.dispatch("token.create", frame.payload, this.#session(connection));
      case "token.list":
        return this.#dispatcher.dispatch(
          "token.list",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "token.revoke":
        return this.#dispatcher.dispatch("token.revoke", frame.payload, this.#session(connection));
      // "daemon.stop" is deliberately absent from this switch: `#dispatchLine` intercepts it
      // itself, ahead of the protocol-mismatch and `#stopping` gates (ADR §6's frozen exception,
      // scoped to protocol version only -- still gated on a completed handshake and the `admin`
      // role there), so it never reaches `#handleRequest`.
      default:
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }

  /** Builds the ADR §2/§4 session for one dispatched call from this connection's fixed
   * principal/role plus its currently-held leases and heartbeat capability. `onProgress` is
   * unset here -- only `#requestLease` needs one, and builds its own session inline so the
   * closure can see that specific call's `requestId`. */
  #session(connection: Connection): DispatchSession {
    return {
      heartbeatCapability: connection.heartbeatCapability,
      heldLeaseIds: connection.heldLeaseIds,
      manageEventSubscription: (subscribe) => this.#manageEventSubscription(connection, subscribe),
      principal: connection.principal,
      role: connection.role,
    };
  }

  /** Connection-scoped: tears down any existing `events.subscribe` unconditionally (matches
   * the pre-dispatcher behaviour -- a second `subscribe` replaces the first), then, if asked,
   * wires a fresh one that pushes every bus event to this connection. Kept in `DaemonServer`
   * because event delivery is a push (ADR §2: pushes stay with the transport); the dispatcher's
   * `events.subscribe`/`events.unsubscribe` handlers do nothing but call this. */
  #manageEventSubscription(connection: Connection, subscribe: boolean): string | undefined {
    connection.unsubscribeEvents?.();
    connection.unsubscribeEvents = undefined;
    connection.subscriptionId = undefined;
    if (!subscribe) return undefined;
    this.#eventSubscriptionSeq += 1;
    const subscriptionId = `sub_${this.#eventSubscriptionSeq}`;
    connection.subscriptionId = subscriptionId;
    connection.unsubscribeEvents = this.options.eventBus.subscribeAll((event) => {
      void this.#pushEvent(connection.socket, subscriptionId, event);
    });
    return subscriptionId;
  }

  /**
   * The held-lease tracking and progress-delivery wiring ADR §2 keeps in `DaemonServer`
   * ("DaemonServer keeps framing, connection lifecycle, held-lease tracking, and pushes; it
   * loses the request switch"). The actual lease acquisition is `Dispatcher`'s
   * `lease.request` handler; this method's job is everything around that call that depends on
   * *this connection* rather than on the operation itself.
   */
  async #requestLease(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
  ): Promise<unknown> {
    let progressSocket: IpcConnection | undefined = connection.socket;
    const disposeProgress = () => {
      progressSocket = undefined;
    };
    connection.progressDisposers.add(disposeProgress);
    // `requesterId` is only meaningful after input parsing, which `dispatch()` below also
    // does -- parsed again here (cheap, side-effect-free) purely so `progressRequesters`
    // tracks the same id the dispatcher's handler will actually use, and a connection close
    // mid-request detaches progress from the right queued waiter. A parse failure here just
    // falls back to the connection's principal; `dispatch()` throws `BAD_REQUEST` before any
    // waiter is created, so no queue entry will ever exist to detach.
    const parsedForTracking = leaseRequest.input.safeParse(value ?? {});
    const requesterId =
      (parsedForTracking.success ? parsedForTracking.data.requesterId : undefined) ??
      connection.principal;
    connection.progressRequesters.add(requesterId);
    let grant;
    try {
      grant = await this.#dispatcher.dispatch("lease.request", value ?? {}, {
        ...this.#session(connection),
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            void this.#pushProgress(progressSocket, requestId, progress);
          }
        },
      });
    } finally {
      connection.progressDisposers.delete(disposeProgress);
      connection.progressRequesters.delete(requesterId);
      disposeProgress();
    }
    if (grant.lease.mode === "held" && (connection.closed || this.#stopping)) {
      await this.options.leases.release(grant.lease.id, "closed");
    } else if (grant.lease.mode === "held") {
      connection.heldLeaseIds.add(grant.lease.id);
    }
    return grant;
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
   * Pushes a lease-ended fact to every live connection whose principal owns `leaseId` (ADR
   * §8: "every live connection whose principal owns the lease, in either mode" -- not just the
   * held-lease holder, which is the bug this PR fixes: a detached holder used to learn of a
   * crash only when a renew failed). Also stops tracking the lease as held on whichever
   * connection had it in `heldLeaseIds` (there is at most one), so a later connection close
   * does not try to release it again -- the held set survives this PR for exactly that
   * bookkeeping, nothing else (ADR §8: "The held set is kept only for release-on-close").
   * Reacts to the existing post-commit lease.expired / lease.released facts (observer-only; no
   * transaction waits on this). `ownerId` comes from the event payload, not a registry lookup:
   * by the time this fires the lease has already been removed from the registry.
   */
  #notifyLeaseLost(leaseId: string, deviceId: string, reason: string, ownerId: string): void {
    for (const connection of this.#connections) {
      connection.heldLeaseIds.delete(leaseId);
      // Suppresses the push for exactly the connection that asked for this release itself
      // (see `selfInitiatedReleases`'s comment) -- every other connection sharing the owner
      // still gets pushed, which is the owner-routed fan-out this PR adds.
      if (connection.selfInitiatedReleases.delete(leaseId)) continue;
      if (connection.principal !== ownerId) continue;
      void this.#pushLeaseLost(connection.socket, { deviceId, leaseId, reason });
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

  /** Reacts to the post-commit `device.crash-detected` fact (already translated, with
   * `ownerId`, by `#ownerRoutedFacts`); observer-only, nothing awaits this. Routed to every
   * live connection owning the lease (ADR §8), same as lease-lost. */
  #notifyDeviceUnhealthy(leaseId: string, deviceId: string, ownerId: string): void {
    for (const connection of this.#connections) {
      if (connection.principal !== ownerId) continue;
      void this.#pushDeviceUnhealthy(connection.socket, { deviceId, leaseId, reason: "crashed" });
    }
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

  /** Reacts to the post-commit `device.recovered` fact (already translated, with `ownerId`,
   * by `#ownerRoutedFacts`); observer-only, nothing awaits this. Routed to every live
   * connection owning the lease (ADR §8), same as lease-lost. */
  #notifyDeviceRecovered(
    leaseId: string,
    deviceId: string,
    attempts: number,
    ownerId: string,
  ): void {
    for (const connection of this.#connections) {
      if (connection.principal !== ownerId) continue;
      void this.#pushDeviceRecovered(connection.socket, { attempts, deviceId, leaseId });
    }
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

/**
 * Resolves the wire `code` for a socket response. `ProtocolError` is socket-framing-specific
 * (thrown only while parsing a request frame, before a `Session` exists -- see its own doc) and
 * stays local to this file; every other error this daemon can throw is classified by the one
 * shared table both transports read -- see `./error-code.js`'s module doc (ADR 0003 §7, review
 * finding B5: this used to be its own hand-written `instanceof` chain that silently drifted
 * from HTTP's).
 */
function errorCode(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.code;
  }
  return classifyError(error) ?? "INTERNAL";
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
