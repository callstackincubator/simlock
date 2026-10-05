import type { EventBus } from "../bus/index.js";
import type { Clock, IdGenerator, Logger, SystemStats } from "../ports/index.js";
import {
  type CapacityReader,
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
import type { DeviceModeReader, LeaseCommands, QueueControl } from "./lease-ports.js";
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
  readonly logger?: Logger;
  readonly registry: Registry;
  readonly systemStats: SystemStats;
  readonly describeFailure?: (error: unknown) => LeaseRequestFailure;
  readonly defaultModes?: Readonly<Partial<Record<Platform, DeviceMode>>>;
  readonly modelPreferences?: ModelPreferences;
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
  enterFromStalledTransition(deviceId: string): Promise<void>;
  /** The daemon's startup order: leasing's steps, core's device steps, then the first queue depth. */
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
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.modelPreferences === undefined
      ? {}
      : { modelPreferences: options.modelPreferences }),
    registry: options.registry,
    systemStats: options.systemStats,
  });
  const leasing = createLeasing({
    clock: options.clock,
    components: options.components,
    config: options.config,
    core,
    eventBus: options.eventBus,
    idGenerator: options.idGenerator,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.describeFailure === undefined ? {} : { describeFailure: options.describeFailure }),
    ...(options.defaultModes === undefined ? {} : { defaultModes: options.defaultModes }),
    ...(options.modelPreferences === undefined
      ? {}
      : { modelPreferences: options.modelPreferences }),
  });
  const healthMonitor = leasing.healthMonitor;
  if (healthMonitor === undefined) throw new Error("createLeasing wires the health monitor");
  return {
    core,
    leasing,
    claimReader: core.claimReader,
    cleanup: core.cleanup,
    healthMonitor,
    requests: leasing.requests,
    request: (request, requestOptions) => leasing.request(request, requestOptions),
    release: (leaseId, reason) => leasing.release(leaseId, reason),
    releaseAll: (reason) => leasing.releaseAll(reason),
    renew: (leaseId, ttlMs) => leasing.renew(leaseId, ttlMs),
    expire: (leaseId) => leasing.expire(leaseId),
    enterFromStalledTransition: (deviceId) => core.quarantine.enterFromStalledTransition(deviceId),
    nuke: (deleteDevices) => core.nuke.nuke(deleteDevices),
    async convergeRunningCapacity() {
      await leasing.startup();
      await core.converge();
      leasing.announceQueueDepth();
    },
    settle: () => leasing.settle(),
    dispose() {
      core.dispose();
      leasing.dispose();
    },
    get queueDepth() {
      return leasing.queueDepth;
    },
    waitingRequests: () => leasing.waitingRequests(),
    cancelPending: (requesterId) => leasing.cancelPending(requesterId),
    pendingRequestOwner: (requesterId) => leasing.pendingRequestOwner(requesterId),
    servesDefaultMode: (spec: DeviceSpec) => leasing.servesDefaultMode(spec),
    get runningCapacity() {
      return core.capacityReader.runningCapacity;
    },
    deviceLimit: (platform) => core.capacityReader.deviceLimit(platform),
    atRamBudget: (platform) => core.capacityReader.atRamBudget(platform),
    get ramBudget() {
      return core.capacityReader.ramBudget;
    },
    listCatalog: (platform) => core.catalog.listCatalog(platform),
    passthrough: (tool, args, context) => core.catalog.passthrough(tool, args, context),
  };
}
