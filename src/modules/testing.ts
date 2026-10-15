import { EventBus } from "../bus/index.js";
import { loadConfig, type Config } from "../core/index.js";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeSystemStats,
  FakeTcpProbe,
  MemoryFilesystem,
  NoopLogger,
  ScriptedProcessRunner,
} from "../ports/index.js";
import type {
  FleetLease,
  FleetLeases,
  GatewayContext,
  GatewayModule,
  ModuleFinding,
  OptionalModuleDefinition,
  WorkerContext,
  WorkerHooks,
  WorkerModule,
  WorkerView,
} from "./index.js";

export interface FakeModuleConfig {
  readonly greeting: string;
}

export interface FakeModuleOptions {
  readonly name: string;
  readonly capabilityName?: string;
  readonly state?: string;
  readonly hooks?: WorkerHooks;
  readonly findings?: () => readonly ModuleFinding[];
  readonly relayTarget?: WorkerModule["relayTarget"];
  readonly mount?: WorkerModule["mount"];
  readonly loadError?: Error;
  readonly onCreate?: (ctx: WorkerContext<FakeModuleConfig>) => void;
  readonly gateway?: FakeGatewaySide;
}

export interface FakeGatewaySide {
  readonly loadError?: Error;
  readonly createError?: Error;
  readonly module?: GatewayModule;
  readonly onCreate?: (ctx: GatewayContext<FakeModuleConfig>) => void;
}

export interface FakeModule {
  readonly definition: OptionalModuleDefinition<FakeModuleConfig>;
  loads: number;
  creates: number;
  gatewayLoads: number;
  gatewayCreates: number;
  readonly gatewayContexts: GatewayContext<FakeModuleConfig>[];
  readonly contexts: WorkerContext<FakeModuleConfig>[];
}

export function fakeModule(options: FakeModuleOptions): FakeModule {
  const fake: FakeModule = {
    contexts: [],
    creates: 0,
    gatewayContexts: [],
    gatewayCreates: 0,
    gatewayLoads: 0,
    definition: {
      config: {
        defaults: { greeting: "hello" },
        gatewayKeys: [],
        validator: (value, path, warn) => {
          const section = value as Record<string, unknown>;
          for (const key of Object.keys(section)) {
            if (key !== "greeting") warn(`Unknown config key: "${path}.${key}"`);
          }
          return { greeting: section["greeting"] ?? "hello" };
        },
      },
      ...(options.gateway === undefined
        ? {}
        : {
            loadGateway: () => {
              const side = options.gateway;
              fake.gatewayLoads += 1;
              if (side?.loadError !== undefined) return Promise.reject(side.loadError);
              return Promise.resolve({
                createGateway: (ctx: GatewayContext<FakeModuleConfig>): GatewayModule => {
                  fake.gatewayCreates += 1;
                  if (side?.createError !== undefined) throw side.createError;
                  fake.gatewayContexts.push(ctx);
                  side?.onCreate?.(ctx);
                  return side?.module ?? {};
                },
              });
            },
          }),
      loadWorker: () => {
        fake.loads += 1;
        if (options.loadError !== undefined) return Promise.reject(options.loadError);
        return Promise.resolve({
          createWorker: (ctx: WorkerContext<FakeModuleConfig>): WorkerModule => {
            fake.creates += 1;
            fake.contexts.push(ctx);
            options.onCreate?.(ctx);
            return {
              capability: {
                name: options.capabilityName ?? options.name,
                read: () => Promise.resolve({ state: options.state ?? "available" }),
              },
              ...(options.findings === undefined ? {} : { findings: options.findings }),
              ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
              ...(options.mount === undefined ? {} : { mount: options.mount }),
              ...(options.relayTarget === undefined ? {} : { relayTarget: options.relayTarget }),
            };
          },
        });
      },
      name: options.name,
    },
    loads: 0,
  };
  return fake;
}

export interface FakeWorkerContext<C> {
  readonly ctx: WorkerContext<C>;
  readonly clock: FakeClock;
  readonly processRunner: ScriptedProcessRunner;
  readonly processSupervisor: FakeProcessSupervisor;
}

export async function fakeWorkerContext<C>(name: string, config: C): Promise<FakeWorkerContext<C>> {
  const clock = new FakeClock(1_000);
  const processRunner = new ScriptedProcessRunner([]);
  const processSupervisor = new FakeProcessSupervisor();
  const daemonConfig: Config = await loadConfig({
    filesystem: new MemoryFilesystem(),
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
  });
  const bus = new EventBus(clock);
  return {
    clock,
    ctx: {
      cancelPending: () => Promise.resolve(undefined),
      clock,
      config,
      daemonConfig,
      dataDirectory: "/tmp/simlock-fake",
      environment: {},
      events: { subscribe: (event, handler) => bus.subscribe(event, handler) },
      filesystem: new MemoryFilesystem(),
      leaseEnvironment: {},
      logger: new NoopLogger(),
      name,
      nodePath: "/usr/bin/node",
      nodeVersion: "22.0.0",
      platforms: ["ios"],
      processRunner,
      processSupervisor,
      tcpProbe: new FakeTcpProbe(),
    },
    processRunner,
    processSupervisor,
  };
}

export interface FakeGatewayContext<C> {
  readonly clock: FakeClock;
  readonly ctx: GatewayContext<C>;
  readonly relayed: { readonly workerId: string; readonly url: string; readonly tenant: string }[];
}

export async function fakeGatewayContext<C>(
  name: string,
  config: C,
  facts: {
    readonly serving?: readonly WorkerView[];
    readonly relay?: (request: Request) => Response;
  } = {},
): Promise<FakeGatewayContext<C>> {
  const clock = new FakeClock(1_000);
  const daemonConfig: Config = await loadConfig({
    filesystem: new MemoryFilesystem(),
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
  });
  const serving = facts.serving ?? [];
  const leases: FleetLeases = {
    all: (): readonly FleetLease[] => [],
    onRemoved: () => undefined,
    resolve: () => undefined,
  };
  const relayed: FakeGatewayContext<C>["relayed"][number][] = [];
  return {
    clock,
    ctx: {
      cancelPending: () => Promise.resolve(undefined),
      clock,
      config,
      daemonConfig,
      grantedDevices: () => [],
      instanceId: "gw-test",
      leases,
      logger: new NoopLogger(),
      name,
      relay: (workerId, request, tenant) => {
        relayed.push({ tenant, url: request.url, workerId });
        return Promise.resolve(facts.relay?.(request) ?? new Response("{}"));
      },
      requesterPrefix: "gw:gw-test:",
      serving: () => serving,
      startedAt: clock.now(),
      worker: (id) => serving.find((view) => view.id === id),
      workers: () => serving,
    },
    relayed,
  };
}
