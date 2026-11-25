import type { EventBus } from "../bus/index.js";
import {
  type Clock,
  type IdGenerator,
  type Logger,
  MemoryFilesystem,
  type SystemStats,
} from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import {
  type CapacityReader,
  type WarmPoolReader,
  type CatalogReader,
  type ComponentInstaller,
  type Core,
  type CoreConfig,
  createCore,
  type DeviceMode,
  type DeviceSpec,
  type Driver,
  type LeaseExpirer,
  type LeaseRequestFailure,
  type MemoryPressureReader,
  type ModelPreferences,
  type NukeExecutor,
  type PassthroughResolver,
  type Platform,
  type Registry,
  type SerializedDecision,
} from "../core/index.js";
import { createLeasing, type Leasing, type LeasingConfig } from "./create-leasing.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import type {
  DeviceModeReader,
  LeaseCommands,
  LeaseEndParticipant,
  QueueControl,
} from "./lease-ports.js";
import type { LeaseHealthMonitor } from "./lease-health-monitor.js";
import { errorMessage } from "../shared/index.js";

export type TestEngineConfig = CoreConfig & LeasingConfig;

export interface TestEngineOptions {
  readonly clock: Clock;
  readonly components: Pick<ComponentInstaller, "claimProvision" | "install">;
  readonly config: TestEngineConfig;
  readonly decisions: SerializedDecision;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly idGenerator: IdGenerator;
  readonly logger?: Logger | undefined;
  readonly memoryPressure?: MemoryPressureReader | undefined;
  readonly registry: Registry;
  readonly state: StateDatabase;
  readonly systemStats: SystemStats;
  readonly describeFailure?: ((error: unknown) => LeaseRequestFailure) | undefined;
  readonly defaultImageTags?: Readonly<Partial<Record<Platform, string>>> | undefined;
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>> | undefined;
  readonly servedModes?: Readonly<Partial<Record<Platform, readonly DeviceMode[]>>> | undefined;
  readonly modelPreferences?: ModelPreferences | undefined;
  readonly leaseEndParticipants?: readonly LeaseEndParticipant[] | undefined;
}

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
  convergeRunningCapacity(): Promise<void>;
  settle(): Promise<void>;
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
    filesystem: new MemoryFilesystem(),
    logger: options.logger,
    ...(options.memoryPressure === undefined ? {} : { memoryPressure: options.memoryPressure }),
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
    defaultImageTags: options.defaultImageTags,
    defaultModes: options.defaultModes,
    servedModes: options.servedModes,
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
    healthMonitor: leasing.healthMonitor as LeaseHealthMonitor,
    requests: leasing.requests,
    request: (request, requestOptions) => leasing.request(request, requestOptions),
    hasRequest: (requesterId, idempotencyKey) => leasing.hasRequest(requesterId, idempotencyKey),
    release: (leaseId, reason) => leasing.release(leaseId, reason),
    releaseAll: (reason) => leasing.releaseAll(reason),
    releaseRun: (runId, ownerId) => leasing.releaseRun(runId, ownerId),
    renew: (leaseId, ttlMs) => leasing.renew(leaseId, ttlMs),
    expire: (leaseId) => leasing.expire(leaseId),
    nuke: (deleteDevices, platform) => core.nuke.nuke(deleteDevices, platform),
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
    message: errorMessage(error),
  };
}
