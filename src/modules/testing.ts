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
  ModuleFinding,
  OptionalModuleDefinition,
  WorkerContext,
  WorkerHooks,
  WorkerModule,
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
}

export interface FakeModule {
  readonly definition: OptionalModuleDefinition<FakeModuleConfig>;
  loads: number;
  creates: number;
  readonly contexts: WorkerContext<FakeModuleConfig>[];
}

export function fakeModule(options: FakeModuleOptions): FakeModule {
  const fake: FakeModule = {
    contexts: [],
    creates: 0,
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
