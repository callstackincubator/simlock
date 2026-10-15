import type { z } from "zod";

import type { EventHandler, EventName } from "../bus/index.js";
import type { OPERATIONS, OperationName, Role } from "../contract/index.js";
import type { Config, Platform } from "../core/index.js";
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
  readonly manageEventSubscription: (subscribe: boolean) => string | undefined;
}

export type ModuleDispatch = <Op extends OperationName>(
  operation: Op,
  input: unknown,
  session: ModuleDispatchSession,
) => Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>>;

export interface ModuleIdentity {
  readonly requesterId: string;
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

export interface WorkerContext<C> {
  readonly name: string;
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
  cancelPending(requesterId: string): Promise<unknown>;
  readonly events: {
    subscribe<Event extends EventName>(event: Event, handler: EventHandler<Event>): () => void;
  };
}

export interface OptionalModuleDefinition<C> {
  readonly name: string;
  readonly config: ModuleConfig<C>;
  loadWorker(): Promise<{ createWorker(ctx: WorkerContext<C>): WorkerModule }>;
  loadGateway?(): Promise<unknown>;
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

export interface ModuleHostOptions {
  readonly role: "worker";
  readonly definitions: readonly OptionalModuleDefinition<unknown>[];
  readonly config: Config;
  readonly logger: Logger;
  readonly context: Omit<WorkerContext<unknown>, "name" | "config" | "daemonConfig" | "logger">;
}
