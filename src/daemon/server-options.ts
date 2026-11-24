import { type EventBus } from "../bus/index.js";
import { type EventHistoryHandle } from "../history/index.js";
import {
  type ComponentInstaller,
  type Config,
  type Registry,
  type CleanupReaper,
  type Doctor,
  type DriverRejection,
  type HostFacts,
  type Nuke,
  type BaselineService,
  type WarmKindForgetter,
  type CapacityReader,
  type WarmPoolReader,
  type CatalogReader,
  type PassthroughResolver,
  type PhysicalAutoEnrollment,
} from "../core/index.js";
import {
  type LeaseHealthMonitor,
  type PhysicalDeviceWatcher,
  type DeviceModeReader,
  type LeaseCommands,
  type QueueControl,
} from "../leasing/index.js";
import { type Clock, type Logger, type ProcessRunner } from "../ports/index.js";
import {
  type ProtocolRange,
  type StatusLoad,
  type StatusMemoryPressure,
} from "../contract/index.js";
import { type ConnectionHost } from "./connection-host.js";
import { type Auth, type SessionRoleResolver, type TokenOperations } from "../auth/index.js";
import { Dispatcher, type ContractDispatcher, type DispatcherOptions } from "./dispatcher.js";
import { type OwnerRoutedFacts } from "./owner-routed-facts.js";
import { classifyError } from "./error-code.js";
import { type RelayTargets, type TwoWayRelayTargets } from "./relay.js";
import { type UpdateCoordinator } from "./update-coordinator.js";

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
  readonly autoEnrollment?: Pick<PhysicalAutoEnrollment, "dispose" | "start"> | undefined;
  readonly enrollment?: DispatcherOptions["enrollment"];
  readonly nuke?: Nuke;
  readonly warmKinds?: WarmKindForgetter;
  readonly baselines?: Pick<BaselineService, "list" | "remove" | "save">;
  readonly seeds?: DispatcherOptions["seeds"];
  readonly passthrough?: PassthroughResolver;
  readonly inputs?: DispatcherOptions["inputs"];
  readonly processRunner?: ProcessRunner;
  readonly leaseFiles?: DispatcherOptions["leaseFiles"];
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
  readonly memoryPressure?: { current(): StatusMemoryPressure | undefined; dispose(): void };
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
   * why: Stops an auxiliary frontend (today: the HTTP gateway's listener, which `worker-composition.ts` or `main.ts` starts
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
  readonly leaseSnapshot?: () => readonly {
    readonly id: string;
    readonly ownerId: string;
    readonly runId?: string | undefined;
  }[];
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

export type DaemonHealth = "starting" | "running" | "failed";

// fallow-ignore-next-line complexity -- one conditional spread per optional dependency.
export function buildDispatcher(
  options: DaemonServerCommonOptions & DaemonServerEngineOptions,
  hooks: {
    readonly awaitReady: () => Promise<void>;
    readonly health: () => DaemonHealth;
    readonly closeSessionsForToken: (tokenId: string) => void;
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
    ...(options.memoryPressure === undefined
      ? {}
      : { memoryPressure: () => options.memoryPressure?.current() }),
    instanceId: options.instanceId,
    leases: options.leases,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.enrollment === undefined ? {} : { enrollment: options.enrollment }),
    ...(options.nuke === undefined ? {} : { nuke: options.nuke }),
    ...(options.warmKinds === undefined ? {} : { warmKinds: options.warmKinds }),
    ...(options.baselines === undefined ? {} : { baselines: options.baselines }),
    ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
    ...(options.passthrough === undefined ? {} : { passthrough: options.passthrough }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.processRunner === undefined ? {} : { processRunner: options.processRunner }),
    ...(options.leaseFiles === undefined ? {} : { leaseFiles: options.leaseFiles }),
    ...(options.execEnv === undefined ? {} : { execEnv: options.execEnv }),
    queue: options.queue,
    ...(options.presence === undefined ? {} : { presence: options.presence }),
    reaper: options.reaper,
    registry: options.registry,
    ...(options.stalls === undefined ? {} : { stalls: options.stalls }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    closeSessionsForToken: hooks.closeSessionsForToken,
    ...(options.update === undefined ? {} : { update: options.update }),
    version: options.version,
  });
}
