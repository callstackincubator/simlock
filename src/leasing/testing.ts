import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, Logger, SystemStats } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import {
  type CapacityReader,
  type WarmPoolReader,
  type CatalogReader,
  type ComponentInstaller,
  type Config,
  type Core,
  createCore,
  type DeviceMode,
  type DeviceSpec,
  type Driver,
  type LeaseExpirer,
  type LeaseRequestFailure,
  type ModelPreferences,
  type NukeExecutor,
  type PassthroughResolver,
  type Platform,
  type Registry,
  type SerializedDecision,
} from "../core/index.js";
import { createLeasing, type Leasing } from "./create-leasing.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import type {
  DeviceModeReader,
  LeaseCommands,
  LeaseEndParticipant,
  QueueControl,
} from "./lease-ports.js";
import type { LeaseHealthMonitor } from "./lease-health-monitor.js";

/**
 * Test-only: wiring other modules' tests use. Only a `*.test.ts` file or a `test-*.ts` helper may
 * import this file, and `pnpm lint` enforces it. Anything production code also uses belongs on
 * `index.ts`.
 */
export interface TestEngineOptions {
  readonly clock: Clock;
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: Config;
  readonly decisions: SerializedDecision;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  readonly logger?: Logger | undefined;
  readonly registry: Registry;
  readonly state: StateDatabase;
  readonly systemStats: SystemStats;
  readonly describeFailure?: ((error: unknown) => LeaseRequestFailure) | undefined;
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>> | undefined;
  readonly modelPreferences?: ModelPreferences | undefined;
  readonly leaseEndParticipants?: readonly LeaseEndParticipant[] | undefined;
}

/**
 * Test-only: `createCore` and `createLeasing` built the way the daemon builds them, behind one
 * handle that carries every port a test drives. `core` and `leasing` are the two real modules.
 */
export interface TestEngine
  extends
    LeaseCommands,
    QueueControl,
    DeviceModeReader,
    CapacityReader,
    WarmPoolReader,
    CatalogReader,
    PassthroughResolver,
    LeaseExpirer,
    NukeExecutor {
  readonly core: Core;
  readonly leasing: Leasing;
  readonly claimReader: Core["claimReader"];
  readonly cleanup: Core["cleanup"];
  readonly healthMonitor: LeaseHealthMonitor;
  readonly requests: Leasing["requests"];
  /** The daemon's startup order: settle requests, read, reconcile leases (timers for the rest), converge devices, then the first queue depth. */
  convergeRunningCapacity(): Promise<void>;
  settle(): Promise<void>;
  /** Cancels leasing's timers: the lease expiry timers a test leaves armed. */
  dispose(): void;
  waitingRequests: Leasing["waitingRequests"];
}

export function createTestEngine(options: TestEngineOptions): TestEngine {
  const core = createCore({
    clock: options.clock,
    components: options.components,
    config: options.config,
    decisions: options.decisions,
    drivers: options.drivers,
    eventBus: options.eventBus,
    logger: options.logger,
    modelPreferences: options.modelPreferences,
    registry: options.registry,
    state: options.state,
    systemStats: options.systemStats,
  });
  const leasing = createLeasing({
    clock: options.clock,
    components: options.components,
    config: options.config,
    core,
    defaultModes: options.defaultModes,
    describeFailure: options.describeFailure ?? describeTestFailure,
    eventBus: options.eventBus,
    idGenerator: options.idGenerator,
    leaseEndParticipants: options.leaseEndParticipants,
    logger: options.logger,
    modelPreferences: options.modelPreferences,
  });
  core.connect(leasing.corePorts);
  return {
    core,
    leasing,
    claimReader: core.claimReader,
    cleanup: core.cleanup,
    // `createLeasing` wires the monitor unless told not to, and this helper never tells it not to.
    healthMonitor: leasing.healthMonitor as LeaseHealthMonitor,
    requests: leasing.requests,
    request: (request, requestOptions) => leasing.request(request, requestOptions),
    release: (leaseId, reason) => leasing.release(leaseId, reason),
    releaseAll: (reason) => leasing.releaseAll(reason),
    renew: (leaseId, ttlMs) => leasing.renew(leaseId, ttlMs),
    expire: (leaseId) => leasing.expire(leaseId),
    nuke: (deleteDevices) => core.nuke.nuke(deleteDevices),
    async convergeRunningCapacity() {
      await leasing.settleRequests();
      const read = await core.readStartup();
      await leasing.reconcile(read);
      await core.converge(read);
      leasing.announceQueueDepth();
    },
    async settle() {
      await leasing.settle();
      await core.settle();
    },
    dispose() {
      core.dispose();
      leasing.dispose();
    },
    get queueDepth() {
      return leasing.queueDepth;
    },
    get physicalQueueDepth() {
      return leasing.physicalQueueDepth;
    },
    waitingRequests: () => leasing.waitingRequests(),
    cancelPending: (requesterId, platform) => leasing.cancelPending(requesterId, platform),
    pendingRequestOwner: (requesterId, platform) =>
      leasing.pendingRequestOwner(requesterId, platform),
    servesDefaultMode: (spec: DeviceSpec) => leasing.servesDefaultMode(spec),
    figures: () => core.warmPoolReader.figures(),
    get runningCapacity() {
      return core.capacityReader.runningCapacity;
    },
    deviceLimit: (platform) => core.capacityReader.deviceLimit(platform),
    atRamBudget: (platform) => core.capacityReader.atRamBudget(platform),
    get ramBudget() {
      return core.capacityReader.ramBudget;
    },
    listCatalog: (platform) => core.catalog.listCatalog(platform),
    passthrough: (tool, device, args, context) =>
      core.catalog.passthrough(tool, device, args, context),
  };
}

// why: the daemon's classifier is out of reach from leasing, and a replay answers the stored code.
function describeTestFailure(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof NoCapacityError ? "NO_CAPACITY" : "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  };
}
