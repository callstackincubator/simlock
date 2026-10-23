import type { z } from "zod";

import type { EventHandler, EventName } from "../bus/index.js";
import type {
  OPERATIONS,
  OperationName,
  Role,
  grantedDeviceSchema,
  workerViewSchema,
} from "../contract/index.js";
import type {
  Config,
  DeviceRecord,
  LeaseRecord,
  PhysicalDriverDevice,
  Platform,
  ScreenAvailability,
  ScreenFeed,
  ScreenSettings,
  VirtualDriverDevice,
} from "../core/index.js";
import type {
  Clock,
  Filesystem,
  Logger,
  ProcessRunner,
  ProcessSupervisor,
  TcpProbe,
} from "../ports/index.js";

export interface ModuleConfig<C> {
  readonly validator: (value: unknown, path: string, warn: (message: string) => void) => unknown;
  readonly defaults: C;
  readonly gatewayKeys: readonly string[];
  check?(section: C, config: Config): void;
}

export interface ModuleFinding {
  readonly message: string;
  readonly remedy: string;
}

export interface ModuleEndedLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly platform: Platform;
  readonly reason: "explicit" | "killed" | "expired" | "device-lost";
}

export interface ModuleLeaseEndParticipant {
  leaseEnded(ended: ModuleEndedLease, signal: AbortSignal): Promise<void>;
}

export interface ModuleCapabilitySource {
  readonly name: string;
  readonly read: () => Promise<{ readonly state: string; readonly reason?: string }>;
}

export type ModuleRelayTarget = (
  request: Request,
  tenant: string,
  leaseId: string | undefined,
) => Promise<Response>;

export interface ModuleDispatchSession {
  readonly principal: string;
  readonly role: Role;
  readonly name?: string;
  readonly via: "token" | "proxy" | "socket" | "uplink";
  readonly manageEventSubscription: (subscribe: boolean) => string | undefined;
}

export type ModuleDispatch = <Op extends OperationName>(
  operation: Op,
  input: unknown,
  session: ModuleDispatchSession,
) => Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>>;

export interface ModuleIdentity {
  readonly principal: string;
  readonly role: "agent" | "operator" | "worker";
}

export type ModuleHandler = (request: Request, identity: ModuleIdentity) => Promise<Response>;

export interface ModuleMount {
  readonly prefix: string;
  handle(request: Request, identity: ModuleIdentity): Promise<Response>;
}

export interface MountDeps {
  readonly dispatch: ModuleDispatch;
}

export interface WorkerHooks {
  readonly afterSocketClaimed?: () => void | Promise<void>;
  readonly beforeDeviceReclaim?: (lease: ModuleEndedLease, signal: AbortSignal) => Promise<void>;
  readonly beforeDrain?: () => Promise<void>;
  readonly beforeDriversDispose?: () => Promise<void>;
}

export interface WorkerModule {
  readonly capability: ModuleCapabilitySource;
  readonly relayTarget?: ModuleRelayTarget;
  readonly mount?: (deps: MountDeps) => ModuleHandler;
  readonly findings?: () => readonly ModuleFinding[];
  readonly hooks?: WorkerHooks;
}

// why: a read of the worker's registry as it stands, so a module that serves a lease checks the lease
// against the worker's own record rather than against what a caller claims.
export interface ModuleRegistryView {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

// why: the drivers' screen capture, routed by platform, without handing a module the drivers.
export interface ModuleScreens {
  openScreen(
    platform: Platform,
    device: VirtualDriverDevice | PhysicalDriverDevice,
    settings: ScreenSettings,
    signal: AbortSignal,
  ): Promise<ScreenFeed>;
  screenAvailability(): Promise<readonly ScreenAvailability[]>;
}

export interface WorkerContext<C> {
  readonly name: string;
  readonly instanceId: string;
  readonly config: C;
  readonly daemonConfig: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly tcpProbe: TcpProbe;
  readonly dataDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly platforms: readonly Platform[];
  readonly leaseEnvironment: Readonly<Record<string, string>>;
  readonly registry: ModuleRegistryView;
  readonly screens: ModuleScreens;
  cancelPending(requesterId: string): Promise<unknown>;
  readonly events: {
    subscribe<Event extends EventName>(event: Event, handler: EventHandler<Event>): () => void;
  };
}

export type WorkerView = z.infer<typeof workerViewSchema>;

export type FleetGrantedDevice = z.infer<typeof grantedDeviceSchema> & {
  readonly workerId: string;
};

export interface FleetLease {
  readonly gatewayLeaseId: string;
  readonly workerId: string;
  readonly workerLeaseId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly grantedAt: number;
}

export interface FleetLeases {
  all(): readonly FleetLease[];
  resolve(gatewayLeaseId: string): FleetLease | undefined;
  onRemoved(listener: (entry: FleetLease) => void): void;
}

export interface GatewayHooks {
  readonly beforeDrain?: () => Promise<void>;
}

export interface GatewayModule {
  readonly mount?: (deps: MountDeps) => ModuleHandler;
  readonly hooks?: GatewayHooks;
}

export interface GatewayContext<C> {
  readonly name: string;
  readonly config: C;
  readonly daemonConfig: Config;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly startedAt: number;
  readonly requesterPrefix: string;
  workers(): readonly WorkerView[];
  worker(id: string): WorkerView | undefined;
  serving(): readonly WorkerView[];
  grantedDevices(): readonly FleetGrantedDevice[];
  readonly leases: FleetLeases;
  relay(workerId: string, request: Request, tenant: string, leaseId?: string): Promise<Response>;
  cancelPending(requesterId: string): Promise<unknown>;
}

// why: plain data in a `definition.ts`, which imports nothing from its module; the OpenAPI document is its only reader.
export interface ModuleHttpResponse {
  readonly description: string;
  readonly contentTypes?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly errorCodes?: readonly string[];
}

export interface ModuleHttpRoute {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly description: string;
  readonly statuses: Readonly<Record<number, ModuleHttpResponse>>;
}

export interface OptionalModuleDefinition<C> {
  readonly name: string;
  readonly config: ModuleConfig<C>;
  readonly http?: { readonly routes: readonly ModuleHttpRoute[] };
  loadWorker(): Promise<{ createWorker(ctx: WorkerContext<C>): WorkerModule }>;
  loadGateway?(): Promise<{ createGateway(ctx: GatewayContext<C>): GatewayModule }>;
}

export interface ModuleHost {
  readonly capabilitySources: readonly ModuleCapabilitySource[];
  readonly relayTargets: Readonly<Record<string, ModuleRelayTarget>>;
  readonly leaseEndParticipants: readonly ModuleLeaseEndParticipant[];
  mounts(deps: MountDeps): readonly ModuleMount[];
  findings(): readonly {
    readonly kind: "module-unavailable";
    readonly module: string;
    readonly message: string;
    readonly remedy: string;
  }[];
  afterSocketClaimed(): void;
  beforeDrain(): Promise<void>;
  beforeDriversDispose(): Promise<void>;
}

export interface GatewayParts {
  readonly clock: Clock;
  readonly instanceId: string;
  readonly startedAt: number;
  readonly requesterPrefix: string;
  workers(): readonly WorkerView[];
  worker(id: string): WorkerView | undefined;
  grantedDevices(): readonly FleetGrantedDevice[];
  readonly leases: FleetLeases;
  relay(
    workerId: string,
    call: {
      readonly request: Request;
      readonly target: string;
      readonly tenant: string;
      readonly leaseId?: string;
    },
  ): Promise<Response>;
  cancelPending(requesterId: string): Promise<unknown>;
}

export interface GatewayModuleHost {
  mounts(deps: MountDeps): readonly ModuleMount[];
  beforeDrain(): Promise<void>;
}

export interface GatewayHostOptions {
  readonly role: "gateway";
  readonly definitions: readonly OptionalModuleDefinition<unknown>[];
  readonly config: Config;
  readonly logger: Logger;
  readonly parts: GatewayParts;
}

export interface ModuleHostOptions {
  readonly role: "worker";
  readonly definitions: readonly OptionalModuleDefinition<unknown>[];
  readonly config: Config;
  readonly logger: Logger;
  readonly context: Omit<WorkerContext<unknown>, "name" | "config" | "daemonConfig" | "logger">;
}
