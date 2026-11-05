import { z } from "zod";

import { type EventBus } from "../bus/index.js";
import type { EventHistoryHandle } from "../history/index.js";
import {
  type ComponentInstaller,
  type Config,
  type Registry,
  type CleanupReaper,
  type Doctor,
  type DriverRejection,
  type HostFacts,
  NoDriverError,
  type Nuke,
  type BaselineService,
  type WarmKindForgetter,
  redactConfig,
  UnknownPassthroughToolError,
  type CapacityReader,
  type WarmPoolReader,
  type CatalogReader,
  type PassthroughResolver,
} from "../core/index.js";
import {
  type LeaseHealthMonitor,
  type PhysicalDeviceWatcher,
  type DeviceModeReader,
  type LeaseCommands,
  type QueueControl,
} from "../leasing/index.js";
import type { Clock, IpcConnection, Logger, ProcessRunner } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { parseRequestFrame, type RequestFrame } from "../daemon-protocol/index.js";
import {
  leaseRelease,
  normalizeProtocolVersion,
  PROTOCOL_VERSION_RANGE,
  relayChannelSchema,
  type OperationName,
  type OPERATIONS,
  type ProtocolRange,
  type Role,
  type StatusLoad,
} from "../contract/index.js";
import type { LinkChannel, LinkConnection } from "../link/index.js";
import { DaemonAlreadyRunningError, type ConnectionHost } from "./connection-host.js";
import {
  resolveAgentRole,
  type Auth,
  type SessionRoleResolver,
  type TokenOperations,
} from "../auth/index.js";
import {
  Dispatcher,
  DispatchError,
  type ContractDispatcher,
  type DispatcherOptions,
  type DispatchSession,
} from "./dispatcher.js";
import { OwnerRoutedFactBus, type OwnerRoutedFacts } from "./owner-routed-facts.js";
import { classifyError, StartupFailedError } from "./error-code.js";
import { RelayConnection, type RelayTargets, type TwoWayRelayTargets } from "./relay.js";
import {
  type Connection,
  errorMessage,
  errorStack,
  type RequestId,
  respondError,
  writeFrame,
} from "./server-connection.js";
import { errorCode, Handshake, parseInput, ProtocolError } from "./server-hello.js";
import { ConnectionPushes } from "./server-pushes.js";
import type { UpdateCoordinator } from "./update-coordinator.js";

/**
 * why: kept in the type rather than making every field optional: a gateway passes `dispatcher` instead,
 * and omitting `queue` from a worker's options stays a compile error.
 */
export interface DaemonServerEngineOptions {
  readonly capabilitySources?: DispatcherOptions["capabilitySources"];
  readonly capacity: CapacityReader;
  readonly warmPool: WarmPoolReader;
  readonly deviceModes: DeviceModeReader;
  readonly catalog: CatalogReader;
  readonly components: Pick<ComponentInstaller, "install" | "inProgress" | "list" | "remove">;
  readonly doctor?: Doctor;
  readonly eventHistory: Pick<EventHistoryHandle, "replay" | "replayPage" | "status">;
  readonly historyPath?: string;
  readonly leases: LeaseCommands;
  readonly hostFacts: () => HostFacts;
  readonly load?: () => StatusLoad | undefined;
  readonly instanceId: string;
  readonly queue: QueueControl;
  readonly presence?: DispatcherOptions["presence"];
  readonly reaper: CleanupReaper;
  readonly healthMonitor?: LeaseHealthMonitor | undefined;
  readonly physicalDeviceWatcher?: PhysicalDeviceWatcher | undefined;
  readonly enrollment?: DispatcherOptions["enrollment"];
  readonly nuke?: Nuke;
  readonly warmKinds?: WarmKindForgetter;
  readonly baselines?: Pick<BaselineService, "list" | "remove" | "save">;
  readonly passthrough?: PassthroughResolver;
  readonly inputs?: DispatcherOptions["inputs"];
  readonly processRunner?: ProcessRunner;
  readonly relayTargets?: RelayTargets;
  readonly relayTwoWayTargets?: TwoWayRelayTargets;
  readonly execEnv?: NodeJS.ProcessEnv;
  readonly registry: Registry;
  readonly stalls?: DispatcherOptions["stalls"];
  readonly tokens?: TokenOperations;
  readonly update?: UpdateCoordinator;
}

export interface DaemonServerCommonOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly defaultRequesterId: string;
  /**
   * why: the daemon serves without a platform whose driver refused to start (safety rule 9), so each
   * refusal lands as an event in the ring buffer here.
   */
  readonly driverRejections?: readonly DriverRejection[];
  readonly eventBus: EventBus;
  readonly host: ConnectionHost;
  readonly hostLoad?: { start(): void; dispose(): void };
  readonly logger?: Logger;
  readonly protocolVersion?: number | ProtocolRange;
  readonly version: string;
  readonly resolveRole?: SessionRoleResolver;
  /**
   * why: ADR §5's per-start admin secret. Undefined is a legitimate default for tests that don't
   * exercise the admin handshake at all -- `start()`/`#stop()` simply skip the persist/remove
   * calls below when it is absent, same style as `doctor`/`nuke`.
   */
  readonly adminSecret?: Auth["adminSecret"];
  /**
   * why: Startup recovery work (doctor reconciliation, running-capacity convergence) run
   * *after* the socket is claimed, so reachability never depends on it. `hello` and
   * `status.get` answer immediately; every other request type parks on this promise.
   * A rejection here stops the daemon rather than leaving it half-open — see `start()`.
   */
  readonly converge?: () => Promise<void>;
  /**
   * why: Awaits lease work the subsystem is finishing off its callers' paths — today the
   * backgrounded device reclaims a release hands off (see `LeaseReleaseCoordinator`).
   * A graceful stop drains it so the pool is left settled; an ungraceful death leaves
   * it for startup recovery. The stop itself releases nothing (ADR 0004 §3), so what this
   * drains is work somebody else's release already handed off; it runs before `dispose`, so a
   * quarantine retry timer armed by a reclaim settling late is still cancelled.
   */
  readonly settle?: () => Promise<void>;
  /**
   * why: Called synchronously the moment a stop is asked for, before anything is awaited: it closes
   * to new work whatever `settle` will later wait for (the warm pool), so nothing started in the
   * window while auxiliary frontends stop is something the drain then waits out (architecture
   * rule 12).
   */
  readonly beginStop?: () => void;
  /**
   * why: Releases what the daemon holds beyond its own state on shutdown, and on a start that
   * fails at the claim or the `admin.token` write: timers the lease subsystem armed (quarantine
   * retries), and every driver's own external resources.
   * Awaited, because a driver's release is asynchronous and a stop that returned before it
   * finished would report a shutdown that had not happened.
   */
  readonly dispose?: () => void | Promise<void>;
  /**
   * why: Stops an auxiliary frontend (today: the HTTP gateway's listener, which `main.ts` starts
   * from `onSocketClaimed`, partway through `start()`) before anything else in `stop()` runs, so
   * no request arriving through it can ever observe a stopping engine. A no-op default when
   * no auxiliary frontend is running.
   */
  readonly stopAuxiliary?: () => Promise<void>;
  /**
   * why: ADR 0003 §2's "an HTTP request during startup now waits like a socket request instead of
   * being refused" needs the HTTP gateway actually listening *before* convergence finishes --
   * otherwise there is nothing for a request to park against, it just gets connection-refused
   * the way it always did. Called synchronously right after `#readyPromise` is assigned (so any
   * request `dispatch()` serves as a result of this callback already parks correctly) and after
   * the socket claim and the admin secret write, but *before* awaiting convergence -- an
   * auxiliary frontend started from here must not itself assume convergence is done. A no-op
   * default leaves today's behaviour (no auxiliary frontend at all) unchanged.
   */
  readonly onSocketClaimed?: () => void;
  /**
   * why: #118: a gateway's own `OwnerRoutedFacts` (`src/gateway/owner-routed-facts.ts`'s
   * `GatewayOwnerRoutedFacts`), replacing the inert one gateway mode has used since #117. Worker
   * mode ignores this entirely -- it builds its own `OwnerRoutedFactBus` from the engine's
   * registry, exactly as before. Structurally typed (not imported) so this module need not
   * depend on `src/gateway`; see that class's own doc comment for why the shapes line up with
   * no cast.
   */
  readonly ownerRoutedFacts?: OwnerRoutedFacts & { dispose(): void };
  /**
   * why: #118: every lease this daemon currently knows about, for `lease.release-all`'s self-push
   * suppression (`#handleRequest`'s `lease.release-all` case below). Worker mode reads its own
   * registry directly and never needs this (`this.#engine?.registry` already answers it); a
   * gateway has no registry, so it supplies its fleet lease index's own entries here instead --
   * without it, a fleet client's own `lease.release-all` would push every one of its own
   * `lease-lost` facts back at itself, since nothing would ever mark them self-initiated.
   * Optional so a test exercising neither engine nor gateway leases need not supply one.
   */
  readonly leaseSnapshot?: () => readonly { readonly id: string; readonly ownerId: string }[];
}

/**
 * why: ADR 0005 §32: one transport, two dispatchers. A worker passes its engine and gets the
 * `Dispatcher` built for it; a gateway passes a ready-made `dispatcher` (its own handlers, over
 * worker views and uplinks) and no engine at all. The union -- rather than one interface with
 * everything optional -- is what keeps each mode's requirements checked at compile time.
 */
export type DaemonServerOptions =
  | (DaemonServerCommonOptions & DaemonServerEngineOptions & { readonly dispatcher?: undefined })
  | (DaemonServerCommonOptions & {
      readonly dispatcher: ContractDispatcher;
      readonly update?: UpdateCoordinator;
    });

type DaemonHealth = "starting" | "running" | "failed";

// fallow-ignore-next-line complexity -- one conditional spread per optional dependency.
function buildDispatcher(
  options: DaemonServerCommonOptions & DaemonServerEngineOptions,
  hooks: {
    readonly awaitReady: () => Promise<void>;
    readonly health: () => DaemonHealth;
  },
): Dispatcher {
  return new Dispatcher({
    awaitReady: hooks.awaitReady,
    ...(options.capabilitySources === undefined
      ? {}
      : { capabilitySources: options.capabilitySources }),
    capacity: options.capacity,
    warmPool: options.warmPool,
    catalog: options.catalog,
    deviceModes: options.deviceModes,
    clock: options.clock,
    components: options.components,
    config: options.config,
    ...(options.doctor === undefined ? {} : { doctor: options.doctor }),
    errorCode: classifyError,
    eventBus: options.eventBus,
    eventHistory: options.eventHistory,
    ...(options.historyPath === undefined ? {} : { historyPath: options.historyPath }),
    health: hooks.health,
    hostFacts: options.hostFacts,
    ...(options.load === undefined ? {} : { load: options.load }),
    instanceId: options.instanceId,
    leases: options.leases,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.enrollment === undefined ? {} : { enrollment: options.enrollment }),
    ...(options.nuke === undefined ? {} : { nuke: options.nuke }),
    ...(options.warmKinds === undefined ? {} : { warmKinds: options.warmKinds }),
    ...(options.baselines === undefined ? {} : { baselines: options.baselines }),
    ...(options.passthrough === undefined ? {} : { passthrough: options.passthrough }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    ...(options.execEnv === undefined ? {} : { execEnv: options.execEnv }),
    queue: options.queue,
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    reaper: options.reaper,
    registry: options.registry,
    ...(options.stalls === undefined ? {} : { stalls: options.stalls }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    ...(options.update === undefined ? {} : { update: options.update }),
    version: options.version,
  });
}

export class DaemonServer {
  readonly #connections = new Set<Connection>();
  readonly #protocolRange: ProtocolRange;
  readonly #unsubscribeLeaseLost: Array<() => void> = [];
  readonly #logger: Logger;
  #stopping = false;
  #closingConnections = false;
  #stopPromise: Promise<void> | undefined;
  #health: DaemonHealth = "starting";
  #readyPromise: Promise<void> | undefined;
  // why: a request that arrives on an uplink before `start()` has claimed its socket parks here, so it never runs ahead of convergence.
  readonly #beforeReady = quietDeferred();
  /**
   * why: Every `#dispatchLine` call that starts while `#health` is still `"starting"`,
   * tracked so a convergence failure can genuinely drain them -- await each one's
   * own response actually being written -- before closing sockets, rather than
   * hoping a `stop()` scheduling gap gives them time to run. See the catch in
   * `start()`.
   */
  readonly #parkedDispatches = new Set<Promise<void>>();
  readonly #dispatcher: ContractDispatcher;
  readonly #workerDispatcher: Dispatcher | undefined;
  readonly #handshake: Handshake;
  readonly #pushes: ConnectionPushes;
  /**
   * why: The worker engine, or `undefined` in gateway mode (ADR 0005 §33: a gateway has no
   * registry, capacity or lifecycle to hold). Every engine touchpoint below is written
   * against this rather than `this.options`, so "what a gateway does not have" is one
   * `?.` at each site instead of a mode flag threaded through the class.
   */
  readonly #engine: DaemonServerEngineOptions | undefined;
  readonly #ownerRoutedFacts: OwnerRoutedFacts & { dispose(): void };

  constructor(private readonly options: DaemonServerOptions) {
    this.#protocolRange =
      options.protocolVersion === undefined
        ? PROTOCOL_VERSION_RANGE
        : normalizeProtocolVersion(options.protocolVersion);
    this.#logger = options.logger ?? new NoopLogger();
    this.#handshake = new Handshake({
      defaultRequesterId: options.defaultRequesterId,
      logger: this.#logger,
      protocolRange: this.#protocolRange,
      resolveRole: options.resolveRole ?? resolveAgentRole,
      version: options.version,
    });
    this.#pushes = new ConnectionPushes({
      connections: this.#connections,
      eventBus: options.eventBus,
      logger: this.#logger,
    });
    // why: ADR §8: the same translation `ConnectionPushes`' `notifyLeaseLost`/`notifyDeviceUnhealthy`/
    // `notifyDeviceRecovered` route from is what the HTTP gateway's `LeaseNoticeBuffer`
    // consumes too (see `ownerRoutedFacts` getter and `main.ts`) -- one bus subscription
    // per raw event, not one per consumer.
    if (options.dispatcher === undefined) {
      // why: Worker mode: build the engine-backed `Dispatcher` exactly as before. `options` narrows
      // to the engine arm of the union here, so every field it needs is still required at
      // compile time.
      const engine: DaemonServerEngineOptions = options;
      this.#engine = engine;
      this.#ownerRoutedFacts = new OwnerRoutedFactBus(options.eventBus, engine.registry);
      this.#workerDispatcher = buildDispatcher(options, {
        awaitReady: () => this.#awaitReady(),
        health: () => this.#health,
      });
      this.#dispatcher = this.#workerDispatcher;
    } else {
      this.#engine = undefined;
      this.#dispatcher = options.dispatcher;
      // why: #118: a gateway now issues leases of its own, and `GatewayOwnerRoutedFacts` (built by
      // `main.ts`, with the fleet's own lease index) is what routes their `lease-lost`/
      // `device-unhealthy`/`device-recovered` facts to the right owner -- see that class's doc
      // comment for why a worker's own republished `lease.expired` cannot be routed off its raw
      // payload. Falls back to inert only for a gateway test harness that supplies neither.
      this.#ownerRoutedFacts = options.ownerRoutedFacts ?? inertOwnerRoutedFacts();
    }
  }

  get socketPath(): string {
    return this.options.host.endpoint;
  }

  /** why: Public read of `#health`. A gateway's dispatcher reads it through here (`main.ts` passes
   * `() => daemon.health` as its `health` hook), which is what keeps `status.get` on a gateway
   * reporting the same daemon health a worker does without the gateway holding a second copy. */
  get health(): DaemonHealth {
    return this.#health;
  }

  /** why: Shared with the HTTP gateway (`main.ts`) so its `LeaseNoticeBuffer` consumes the same
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
    // why: Mirrors the socket path's `#stopping` -> `DAEMON_STOPPING` gate in `#dispatchLine` (just
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
   * why: Claims the socket first so reachability never depends on startup recovery work:
   * a lost startup race throws `DaemonAlreadyRunningError` here, before `converge()`
   * runs any device work. Only after the claim does convergence run; `hello` and
   * `status.get` answer throughout, every other request parks on `#readyPromise`
   * (see `#awaitReady`). Node keeps servicing accepted connections while this
   * function's own awaits are pending, so callers observe the socket as connectable
   * well before this promise settles.
   */
  async start(): Promise<void> {
    try {
      await this.#start();
    } catch (error: unknown) {
      this.#beforeReady.reject(error);
      throw error;
    }
  }

  async #start(): Promise<void> {
    try {
      await this.options.host.start((connection) => this.#accept(connection));
      // why: ADR §5: written only after the socket claim above has succeeded -- a daemon that loses
      // the start race throws out of `host.start()` and never reaches this line, so it never
      // touches `admin.token`. Awaited before convergence starts (not raced with it): the file
      // landing is not itself gated on convergence -- `hello` already verifies the in-memory
      // hash regardless -- but there is no reason to let two startup-time writes race each other
      // for no benefit.
      this.options.hostLoad?.start();
      await this.options.adminSecret?.persist();
    } catch (error: unknown) {
      // why: as on a convergence failure below, a request already parked (an uplink's, or a socket's after the claim) gets its DAEMON_STARTUP_FAILED written before the release closes its connection.
      this.#beforeReady.reject(error);
      await Promise.allSettled(this.#parkedDispatches);
      this.#stopping = true;
      // why: a `daemon.stop` accepted after the claim already runs the one teardown, and it is not awaited here: the composition's `stopAuxiliary` waits for this start to settle, so the caller awaits `stop()` once the start has rejected.
      if (this.#stopPromise === undefined) {
        this.#stopPromise = this.#releaseFailedStart(error);
        await this.#stopPromise;
      }
      throw error;
    }
    const readyPromise = this.#converge();
    this.#readyPromise = readyPromise;
    readyPromise.then(this.#beforeReady.resolve, this.#beforeReady.reject);
    // why: See `onSocketClaimed`'s doc: fired only after `#readyPromise` is assigned, so a request
    // the auxiliary frontend starts serving as an immediate result of this call already parks
    // on it correctly via `#awaitReady()`.
    this.options.onSocketClaimed?.();
    try {
      await readyPromise;
    } catch (error: unknown) {
      // why: Convergence failed after the socket was claimed: stop rather than sit there
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

    // why: Convergence succeeded, but a `stop()` may have run to completion while it was in
    // flight -- `daemon.stop` is accepted during startup (see `#dispatchLine`), and an
    // auxiliary frontend that fails to start asks for a stop of its own. Everything below
    // this point arms live machinery: it subscribes to the fact bus, emits `daemon.started`,
    // and starts the health monitor. Running any of that
    // against an already-disposed engine would leave timers armed on a dead daemon and would
    // emit `daemon.started` after `daemon.stopping` -- a fact that is not true when emitted,
    // which `docs/internal/agent-rules/events.md` rule 3 forbids. Bail out instead; the stop that
    // already ran owns the teardown, so there is nothing left for this call to undo.
    if (this.#stopping) {
      this.#logger.info("Daemon converged after a stop was requested; not arming", {
        socketPath: this.options.host.endpoint,
      });
      return;
    }

    // why: Subscribed only now, after convergence, not before `start()` claimed the socket.
    // Convergence ends every lease whose device the startup read does not find running, so the
    // lease facts this window can emit are a `lease.expired` for a lease whose deadline passed
    // while no daemon ran and a `lease.released` (`device-lost`) for one whose device is gone.
    //
    // Such a `lease-lost` push can genuinely be missed, and that is accepted rather than
    // assumed away: the socket has been accepting connections since the claim, `hello` is
    // answered throughout the window, and a client's renew timer may well be connected while
    // `restore()` expires its overdue lease. What that client loses is the push, not the
    // fact -- its next `lease.renew` answers `UNKNOWN_LEASE`, which every holder already
    // treats as the end of the lease (`onLeaseGone`, `src/lease-policy/index.ts`). Wiring the
    // subscription earlier would instead push from a daemon that has not finished converging,
    // which is the worse trade.
    //
    // A parked `lease.request` is safe: `start()`'s own
    // continuation is registered on `#readyPromise` before any later request's (the
    // client can only reach the gate after `host.start()`'s callback is wired, well
    // after `start()` began awaiting), so on the shared microtask queue this
    // subscribe runs before any parked request resumes past `#awaitReady()` -- see
    // "answers hello and status.get..." / "parks a request type..." tests, and the
    // dedicated ordering test below. The next event type added that can fire during
    // convergence should re-check this invariant rather than assume it still holds.
    //
    // `device.crash-detected` / `device.recovered` re-checked: the health monitor
    // that emits them is only started after convergence too (see `createLeasing` /
    // `DaemonServer` startup wiring), so neither can fire during this window either.
    this.#unsubscribeLeaseLost.push(
      this.#ownerRoutedFacts.subscribe((fact) => {
        switch (fact.type) {
          case "lease-lost":
            this.#pushes.notifyLeaseLost(fact.leaseId, fact.deviceId, fact.reason, fact.ownerId);
            return;
          case "device-unhealthy":
            this.#pushes.notifyDeviceUnhealthy(fact.leaseId, fact.deviceId, fact.ownerId);
            return;
          case "device-recovered":
            this.#pushes.notifyDeviceRecovered(
              fact.leaseId,
              fact.deviceId,
              fact.attempts,
              fact.ownerId,
            );
            return;
        }
      }),
    );

    // why: redacted because the payload lands in the ring and `history.db`, and the log line in `daemon.log`, none of which is as guarded as `config.json`; `this.options.config` stays whole for `config.get`.
    const configSnapshot = redactConfig(this.options.config);
    this.options.eventBus.emit(
      "daemon.started",
      { configSnapshot, version: this.options.version },
      "daemon",
    );
    // why: After `daemon.started`, because these are facts about the daemon that just started
    // and a subscriber reading the buffer in order should see it come up first.
    for (const rejection of this.options.driverRejections ?? []) {
      // why: No assertion: `DriverRejection` pairs each event name with that event's own
      // payload, so the contract is checked where the driver module builds the refusal
      // rather than being taken on trust here, one step from the ring buffer.
      this.options.eventBus.emit(rejection.event, rejection.payload, "daemon");
    }
    this.#logger.info("Daemon started", {
      config: configSnapshot,
      protocolVersion: this.#protocolRange.max,
      protocolRange: this.#protocolRange,
      socketPath: this.options.host.endpoint,
      version: this.options.version,
    });
    // why: Armed only here, after convergence: a probe tick shells out per platform, and
    // convergence is already doing that per driver and device. Starting it late is
    // also what keeps the subscriptions above safe -- nothing can emit
    // device.crash-detected during the startup window, because the only emitter is
    // this monitor.
    this.#engine?.healthMonitor?.start();
    this.#engine?.physicalDeviceWatcher?.start();
    // why: a gateway's `events.subscribe` parked on readiness resumes only after this continuation, so the rollback's `daemon.update-failed` waits one turn of the event loop for it to subscribe.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!this.#stopping) this.options.update?.announceResultFile();
  }

  // why: a stale or unreadable result file must never keep the daemon from starting.
  async #reportUpdateResult(): Promise<void> {
    try {
      await this.options.update?.readResultFile();
    } catch (error: unknown) {
      this.#logger.warn("Could not read the update result file", { message: errorMessage(error) });
    }
  }

  async #converge(): Promise<void> {
    try {
      await this.options.converge?.();
      // why: read before health is `running`, so a `daemon.update` that sees `running` also sees the failure a rolled back update left.
      await this.#reportUpdateResult();
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

  async #awaitReady(): Promise<void> {
    try {
      await (this.#readyPromise ?? this.#beforeReady.promise);
    } catch {
      throw new StartupFailedError();
    }
    // why: a request parked before the stop passed the entry gates already; releasing it would start work after `settle()` took its snapshot.
    if (this.#stopping) throw new DispatchError("DAEMON_STOPPING", "Daemon is stopping");
  }

  stop(reason = "requested"): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#stopping = true;
    this.options.beginStop?.();
    this.#stopPromise = this.#stop(reason);
    return this.#stopPromise;
  }

  async #stop(reason: string): Promise<void> {
    // why: Awaited first, before anything below: an auxiliary frontend calls the role interfaces
    // directly rather than parking on `#awaitReady`/this method's own teardown order, so it
    // must be shut off before lease/queue teardown begins -- otherwise a request arriving
    // through it mid-stop could run against an engine already being torn down.
    await this.options.stopAuxiliary?.();
    this.#logger.info("Daemon stopping", { reason });
    this.options.eventBus.emit("daemon.stopping", { reason }, "daemon");
    await this.#disposeEngine();
    // why: a stop releases nothing; leases persist with their deadline. Only work already in
    // flight is drained, so `daemon stop` finishes on a settled pool. Disposal follows rather than
    // precedes it, so a retry timer armed by a reclaim that settles into quarantine is still cancelled.
    await this.options.settle?.();
    await this.options.dispose?.();
    await this.#closeConnections();
    // why: releasing the endpoint lets a replacement write its credential, so removal must happen while this daemon still owns it.
    // why: a failed removal must still release the endpoint, or the stopping daemon keeps listening and blocks its replacement.
    try {
      await this.options.adminSecret?.remove();
    } finally {
      await this.options.host.stop();
    }
    this.#logger.info("Daemon stopped", { reason });
  }

  /**
   * why: a start that fails at the claim or the `admin.token` write never reaches `#stop`, and
   * `startDaemon` hands its caller no daemon to stop, so the reaper's tick and every timer or
   * child the composition armed would keep the process alive with nothing to serve. It runs
   * `#stop`'s order without the stop's facts: no `daemon.stopping` for a daemon that never
   * started, and no `admin.token` removal, since this start never wrote one. Never rejects, so
   * the start's own error is the one its caller sees.
   */
  async #releaseFailedStart(error: unknown): Promise<void> {
    try {
      await this.#disposeEngine();
      // why: a start that lost the race to a live daemon on this folder keeps the composition's
      // parts: its Android driver may have adopted that daemon's adb server through its record,
      // and disposing the driver would reap the server from under the winner.
      if (!(error instanceof DaemonAlreadyRunningError)) {
        await this.options.settle?.();
        await this.options.dispose?.();
      }
      await this.#closeConnections();
      // why: a host that never claimed owns no endpoint, so this removes nothing a live daemon holds.
      await this.options.host.stop();
    } catch (releaseError: unknown) {
      this.#logger.error("Could not release a failed start", {
        message: errorMessage(releaseError),
      });
    }
  }

  async #disposeEngine(): Promise<void> {
    for (const unsubscribe of this.#unsubscribeLeaseLost.splice(0)) unsubscribe();
    this.#ownerRoutedFacts.dispose();
    this.options.hostLoad?.dispose();
    this.#workerDispatcher?.dispose();
    this.#engine?.reaper.dispose();
    this.#engine?.healthMonitor?.dispose();
    // why: every cleanup run in flight (scheduled, dry-run or rule-scoped) still reads the registry
    // and calls drivers; each ends before anything below closes them.
    await this.#engine?.reaper.settle();
    // why: a health tick or recovery reboot already running still acts on a device; it ends before the drivers are disposed.
    await this.#engine?.healthMonitor?.settle();
    this.#engine?.physicalDeviceWatcher?.dispose();
  }

  async #closeConnections(): Promise<void> {
    this.#closingConnections = true;
    for (const connection of this.#connections) {
      await connection.socket.close();
    }
  }

  /**
   * why: ADR 0005 §5: accepts a worker's *outbound* uplink as one more connection on this daemon's
   * own protocol, and grants that session the `admin` role.
   *
   * The grant is not a hole in ADR 0003 §5 ("admin authority comes from a credential in the
   * handshake, never from the socket") -- it is the same rule applied one layer out. §5's
   * prohibition is on inferring authority from a *transport this daemon merely accepted*: a
   * local unix socket proves nothing about who connected. Here the daemon is not accepting
   * anything; it *dialled out*, to the `gateway.url` in its own configuration, presenting the
   * `gateway.token` from that same file, and the gateway verified that token before this
   * connection existed (ADR 0005 §4). The credential in this handshake is that join token,
   * checked by the peer; the trust runs from this worker's own config, which is exactly the
   * kind of statement §5 says admin authority may come from. An operator who does not want a
   * gateway administering this machine removes two config keys.
   */
  acceptUplink(connection: LinkConnection): void {
    this.#accept(connection, "admin", connection);
  }

  #accept(socket: IpcConnection, forcedRole?: Role, link?: LinkConnection): void {
    // why: a stopping daemon still listens until `host.stop()`; a connection opened before the connections are closed gets `DAEMON_STOPPING` (or the `daemon.stop` reply) from the dispatch gates, and only one arriving after that would never be closed.
    if (this.#closingConnections) {
      void socket.close();
      return;
    }
    const connection: Connection = {
      buffer: "",
      closed: false,
      forcedRole,
      helloReceived: false,
      isGatewayUplink: link !== undefined,
      link,
      // why: Overwritten by `Handshake.handle` before any dispatched request can read them -- every
      // path that reaches `#handleRequest` has `connection.helloReceived === true` by
      // construction (`#dispatchLine` routes to `Handshake.handle` until then).
      principal: "",
      role: "agent",
      progressDisposers: new Set(),
      protocolMismatch: undefined,
      relays: new RelayConnection(
        this.#engine?.relayTargets ?? {},
        this.#logger,
        this.#engine?.relayTwoWayTargets ?? {},
      ),
      selfInitiatedReleases: new Set(),
      socket,
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
   * why: Fires `#dispatchLine` without awaiting it, same as before, but while `#health` is
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
      await respondError(connection.socket, null, "BAD_FRAME", errorMessage(error));
      return;
    }

    if (!connection.helloReceived) {
      await this.#handshake.handle(connection, frame);
      return;
    }

    // why: accepted here, in the same turn the line was read, so a request that parks for startup already holds its channel (ADR 0028).
    const relayChannel = this.#acceptRelayChannel(connection, frame);

    // why: `daemon.stop` is a frozen exception (ADR 0003 §6), but only with respect to the
    // *protocol-version* gate: "the daemon accepts it at any protocol version it has ever
    // spoken". It is not frozen with respect to authentication or role -- §3's operation matrix
    // assigns `daemon.stop` role `admin` like any other admin operation, and the ADR's Context
    // section names exactly this gap ("Any local connection can release any lease, nuke, or
    // stop the daemon") as the defect being fixed. So this still requires a completed,
    // successfully authenticated handshake (guaranteed by `connection.helloReceived` above --
    // a rejected credential never reaches here, see `Handshake.handle`) and the resolved role being
    // `admin`, but -- unlike every other operation -- it is checked here, ahead of the
    // `protocolMismatch` and `#stopping` gates below, so it stays reachable: during a version
    // mismatch (`npm upgrade` against a still-running old daemon with leases held -- see §6's
    // "the client never restarts the daemon on mismatch") and while the daemon is already
    // `#stopping`. It is intentionally idempotent: `stop()` itself dedups concurrent callers via
    // `#stopPromise`, so a second `daemon.stop` here just gets the same success reply again.
    if (frame.type === "daemon.stop") {
      if (connection.role !== "admin") {
        await respondError(
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

    // why: `daemon.update` is the second frozen call (ADR 0042 §1): it skips the version gate but not the role check, which the dispatcher still runs, and readiness except for `query`.
    if (connection.protocolMismatch && frame.type !== "daemon.update") {
      relayChannel?.abort();
      await respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_UNSUPPORTED",
        connection.protocolMismatch.message,
        connection.protocolMismatch.details,
      );
      return;
    }

    if (this.#stopping) {
      relayChannel?.abort();
      await respondError(connection.socket, frame.id, "DAEMON_STOPPING", "Daemon is stopping");
      return;
    }

    try {
      const payload = await this.#handleRequest(connection, frame, relayChannel);
      await writeFrame(connection.socket, { id: frame.id, ok: true, payload });
    } catch (error: unknown) {
      relayChannel?.abort();
      const code = errorCode(error);
      // why: A handled error is already on the dispatcher's `operation` line; this one adds the stack.
      if (code === "INTERNAL") {
        this.#logger.error("Unhandled request error", {
          message: errorMessage(error),
          stack: errorStack(error),
          type: frame.type,
        });
      }
      // why: ADR 0003 §7's typed `details` travel with the code when the thrown error carries any
      // (today: the gateway's `WORKER_CONNECTED`/`UNKNOWN_WORKER`/`UNSUPPORTED_IN_GATEWAY_MODE`,
      // and a worker's `UNSUPPORTED_IN_WORKER_MODE`),
      // so a socket client can narrow on them exactly as an HTTP one does.
      await respondError(
        connection.socket,
        frame.id,
        code,
        this.#describeError(error),
        error instanceof DispatchError ? error.details : undefined,
      );
    }
  }

  /**
   * why: A `NO_DRIVER` for a platform whose driver refused to start says nothing on its own:
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
      return rejections.find(
        (candidate) => candidate.passthroughTools?.includes(error.tool) === true,
      );
    }
    return undefined;
  }

  // fallow-ignore-next-line complexity -- one case per request type; the switch is the transport's whole surface.
  async #handleRequest(
    connection: Connection,
    frame: RequestFrame,
    relayChannel: LinkChannel | undefined,
  ): Promise<unknown> {
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.id, frame.payload);
      case "lease.release": {
        const input = parseInput(leaseRelease.input, frame.payload);
        connection.selfInitiatedReleases.add(input.leaseId);
        try {
          return await this.#dispatcher.dispatch(
            "lease.release",
            frame.payload,
            this.#session(connection),
          );
        } finally {
          connection.selfInitiatedReleases.delete(input.leaseId);
        }
      }
      case "lease.release-all": {
        // why: Every lease this principal owns is about to end, and this connection asked for it,
        // so suppress the self-push for each. Read from the registry rather than from
        // per-connection state, which no longer exists (ADR 0004 §3).
        //
        // The snapshot can skew either way against what the dispatched call actually
        // releases, and both ways are acceptable: a lease that expires inside the window is
        // suppressed here even though its `lease-lost` was the daemon's own doing (the caller
        // asked for that lease to end and is about to be told every lease of theirs is gone),
        // and one granted inside the window is not suppressed, so its holder gets the push it
        // would have got for any other force-release. Neither can suppress a push for a lease
        // this principal does not own, which is the property that matters.
        // #118: a gateway has no `#engine`, so it falls back to `options.leaseSnapshot` (its
        // fleet lease index) -- see that option's own doc comment.
        const releasing = (
          this.#engine?.registry.snapshot.leases ??
          this.options.leaseSnapshot?.() ??
          []
        )
          .filter((lease) => connection.role === "admin" || lease.ownerId === connection.principal)
          .map((lease) => lease.id);
        for (const leaseId of releasing) connection.selfInitiatedReleases.add(leaseId);
        try {
          return await this.#dispatcher.dispatch(
            "lease.release-all",
            frame.payload ?? {},
            this.#session(connection),
          );
        } finally {
          for (const leaseId of releasing) connection.selfInitiatedReleases.delete(leaseId);
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
      case "lease.get":
        return this.#dispatcher.dispatch(
          "lease.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "lease.list":
        return this.#dispatcher.dispatch(
          "lease.list",
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
      case "warm.forget":
        return this.#dispatcher.dispatch(
          "warm.forget",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "baseline.list":
        return this.#dispatcher.dispatch(
          "baseline.list",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "baseline.remove":
        return this.#dispatcher.dispatch(
          "baseline.remove",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "baseline.save":
        return this.#dispatcher.dispatch(
          "baseline.save",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "events.replay":
        return this.#dispatcher.dispatch(
          "events.replay",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "usage.get":
        return this.#dispatcher.dispatch(
          "usage.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "inbox.get":
        return this.#dispatcher.dispatch(
          "inbox.get",
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
        // why: Resolution only: the daemon never runs the command. Spawning it here would attach
        // a user's interactive `adb shell` to the daemon's stdio, and the CLI is the process
        // that actually has a terminal.
        return this.#dispatcher.dispatch(
          "driver.passthrough",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "device.exec":
        // why: Unlike `driver.passthrough` above, this one runs the command here -- so it needs the
        // per-call push wiring `lease.request` needs, and gets it the same way.
        return this.#execDevice(connection, frame.id, frame.payload);
      case "device.rotate":
        return this.#dispatcher.dispatch("device.rotate", frame.payload, this.#session(connection));
      case "relay.request":
        return this.#relayRequest(connection, frame.id, frame.payload, relayChannel);
      case "relay.cancel":
        return this.#dispatcher.dispatch("relay.cancel", frame.payload, this.#session(connection));
      case "config.get":
        return this.#dispatcher.dispatch(
          "config.get",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "identity.get":
        return this.#dispatcher.dispatch(
          "identity.get",
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
      // why: ADR 0005 §23. Listed here like any other operation: this switch is the socket's whole
      // surface, and what a *given* daemon answers is the dispatcher's business, not the
      // transport's -- a worker's dispatcher answers `worker.list` about itself and refuses the
      // rest with `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012).
      case "worker.list":
        return this.#dispatcher.dispatch(
          "worker.list",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "worker.drain":
        return this.#dispatcher.dispatch("worker.drain", frame.payload, this.#session(connection));
      case "worker.undrain":
        return this.#dispatcher.dispatch(
          "worker.undrain",
          frame.payload,
          this.#session(connection),
        );
      case "worker.remove":
        return this.#dispatcher.dispatch("worker.remove", frame.payload, this.#session(connection));
      case "worker.update":
        return this.#dispatcher.dispatch("worker.update", frame.payload, this.#session(connection));
      case "alerts.test":
        return this.#dispatcher.dispatch("alerts.test", frame.payload, this.#session(connection));
      case "component.install":
        return this.#installComponent(connection, frame.id, "component.install", frame.payload);
      case "worker.install-component":
        return this.#installComponent(
          connection,
          frame.id,
          "worker.install-component",
          frame.payload,
        );
      case "component.list":
        return this.#dispatcher.dispatch(
          "component.list",
          frame.payload ?? {},
          this.#session(connection),
        );
      case "component.remove":
        return this.#dispatcher.dispatch(
          "component.remove",
          frame.payload,
          this.#session(connection),
        );
      case "device.add":
        return this.#dispatcher.dispatch("device.add", frame.payload, this.#session(connection));
      case "device.remove":
        return this.#dispatcher.dispatch("device.remove", frame.payload, this.#session(connection));
      case "daemon.update":
        return this.#dispatcher.dispatch("daemon.update", frame.payload, this.#session(connection));
      // why: "daemon.stop" is deliberately absent from this switch: `#dispatchLine` intercepts it
      // itself, ahead of the protocol-mismatch and `#stopping` gates (ADR §6's frozen exception,
      // scoped to protocol version only -- still gated on a completed handshake and the `admin`
      // role there), so it never reaches `#handleRequest`.
      default:
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }

  // why: `channel` is wire input, so its shape is checked before it names a channel; a name that fails, or one the link never saw, accepts nothing and the call fails `BAD_REQUEST` later.
  #acceptRelayChannel(connection: Connection, frame: RequestFrame): LinkChannel | undefined {
    if (frame.type !== "relay.request" || connection.link === undefined) return undefined;
    const payload: unknown = frame.payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const name = relayChannelSchema.safeParse((payload as { channel?: unknown }).channel);
    if (!name.success) return undefined;
    try {
      return connection.link.acceptChannel(name.data);
    } catch {
      return undefined;
    }
  }

  #session(connection: Connection): DispatchSession {
    return {
      isGatewayUplink: connection.isGatewayUplink,
      manageEventSubscription: (subscribe) =>
        this.#pushes.manageEventSubscription(connection, subscribe),
      principal: connection.principal,
      relays: connection.relays,
      role: connection.role,
      via: connection.isGatewayUplink === true ? "uplink" : "socket",
    };
  }

  /**
   * why: The progress-delivery wiring ADR 0003 §2 keeps in `DaemonServer` ("DaemonServer keeps
   * framing, connection lifecycle, and pushes; it loses the request switch"). The actual lease
   * acquisition is `Dispatcher`'s `lease.request` handler; this method's job is what is left
   * around that call that depends on *this connection* rather than on the operation itself,
   * which since ADR 0004 is progress routing and nothing else -- a granted lease is not
   * attached to the connection that asked for it in any way.
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
    // why: A connection close only silences this call's pushes (`disposeProgress`): the request
    // itself keeps waiting, and a client that reconnects repeats it to get its answer.
    let grant;
    try {
      grant = await this.#dispatcher.dispatch("lease.request", value ?? {}, {
        ...this.#session(connection),
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            // why: Progress is advisory: one that does not fit the push contract (a `downloading`
            // component the driver named past the contract's bound) or a socket that went away
            // is dropped, and the request carries on to its answer.
            void this.#pushes.progress(progressSocket, requestId, progress).catch(() => {
              this.#logger.warn("A lease progress push was not sent", { stage: progress.stage });
            });
          }
        },
      });
    } finally {
      connection.progressDisposers.delete(disposeProgress);
      disposeProgress();
    }
    // why: A grant that lands after its requester's connection died (or during a stop) is left
    // standing on purpose: ADR 0004 §3 -- connection close means nothing to a lease, so the
    // client that reconnects can renew it, and if none does it expires at its deadline like
    // any other.
    return grant;
  }

  /**
   * why: ADR 0005 §19a's output relay, and the exact counterpart of `#requestLease` above: the
   * operation itself is the dispatcher's `device.exec` handler; what lives here is the part
   * that depends on *this connection* -- turning each chunk into an `output` push carrying this
   * call's frame id, and stopping the moment the socket goes away.
   *
   * The command keeps running after a disconnect rather than being killed with it. That is the
   * same answer ADR 0004 §3 gives for leases (a dead connection is not a dead lease) and the
   * only safe one here: a half-applied `simctl install` interrupted because a client's tunnel
   * blipped is worse than one that finishes with nobody listening, and the daemon has no way to
   * know which half a kill would land in. Its exit code is simply lost with the connection, and
   * `exec.timeoutMs` still bounds how long it can run.
   */
  async #execDevice(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
  ): Promise<unknown> {
    let outputSocket: IpcConnection | undefined = connection.socket;
    const disposeOutput = () => {
      outputSocket = undefined;
    };
    connection.progressDisposers.add(disposeOutput);
    try {
      return await this.#dispatcher.dispatch("device.exec", value ?? {}, {
        ...this.#session(connection),
        // why: Returned rather than fired and forgotten, which is what applies backpressure: the
        // dispatcher hands this promise to the process runner, which stops reading the child
        // until the frame has actually been written (ADR 0005 §19e -- "streamed, never
        // buffered" is only true end to end if a client that does not read slows the command
        // down instead of filling this process). A write that fails on a socket which died
        // between the check and the write (EPIPE) resolves rather than rejecting: the chunk is
        // lost with the connection, the command carries on, and a rejection here would both
        // wedge the child and, unhandled, take the daemon down over a client that hung up.
        onOutput: async (stream, chunk) => {
          if (outputSocket === undefined) return;
          await this.#pushes.output(outputSocket, requestId, stream, chunk).catch(() => undefined);
        },
        // why: ADR 0005 §19a: the process now exists. Fired and forgotten rather than awaited --
        // unlike `onOutput` this carries no backpressure meaning, and the dispatcher calls it
        // synchronously between the spawn and the first chunk. Every peer that negotiates
        // protocol 5 understands the frame (§31), so this is not a signal anyone opts out of.
        onStarted: () => {
          if (outputSocket === undefined) return;
          void this.#pushes.started(outputSocket, requestId).catch(() => undefined);
        },
      });
    } finally {
      connection.progressDisposers.delete(disposeOutput);
      disposeOutput();
    }
  }

  #relayRequest(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
    relayChannel: LinkChannel | undefined,
  ): Promise<unknown> {
    return this.#dispatcher.dispatch("relay.request", value, {
      ...this.#session(connection),
      ...(relayChannel === undefined ? {} : { relayChannel }),
      onRelayHead: (status, headers) =>
        this.#pushes.relayHead(connection.socket, requestId, status, headers),
    });
  }

  /**
   * why: ADR 0010 §6: the counterpart of `#requestLease` for an install. Each progress update becomes
   * a `component-progress` push carrying this call's frame id. A closed connection only
   * silences the pushes (`writeFrame` writes nothing to a closed socket, and a write that fails
   * is dropped): the install carries on for every call joined to it, and a client that
   * reconnects repeats the request to join it again.
   *
   * A gateway's `worker.install-component` takes the same path: its progress names the worker
   * it came from, and the push carries that `workerId` (ADR 0010 §7). A worker's dispatcher
   * refuses it with `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012 §2).
   */
  #installComponent(
    connection: Connection,
    requestId: RequestId,
    operation: "component.install" | "worker.install-component",
    value: unknown,
  ): Promise<unknown> {
    return this.#dispatcher.dispatch(operation, value ?? {}, {
      ...this.#session(connection),
      onComponentProgress: (progress, workerId) => {
        void this.#pushes
          .componentProgress(connection.socket, requestId, progress, workerId)
          .catch(() => undefined);
      },
    });
  }

  #closeConnection(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.helloReceived) {
      // why: ADR 0004 §3: closing a connection is not a lease event. Whatever this principal held
      // is still granted, still counting down its TTL, and still renewable by whatever
      // connects next -- there is nothing to release here and nothing to count.
      this.#logger.info("Connection closed", { principal: connection.principal });
    }
    for (const disposeProgress of connection.progressDisposers) {
      disposeProgress();
    }
    connection.progressDisposers.clear();
    connection.relays.abortAll();
    this.#connections.delete(connection);
    connection.unsubscribeEvents?.();
    connection.unsubscribeEvents = undefined;
  }
}

// why: nobody may be parked on the gate when it rejects, and an unobserved rejection would end the process.
function quietDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, reject, resolve };
}

/**
 * why: An `OwnerRoutedFacts` that never emits. A named function rather than an inline object
 * literal so the intent reads at the one place that would otherwise be a bare `{}`.
 */
function inertOwnerRoutedFacts(): OwnerRoutedFacts & { dispose(): void } {
  return {
    subscribe: () => () => {},
    dispose: () => {},
  };
}
