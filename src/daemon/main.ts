import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EventBus } from "../bus/index.js";
import {
  type ConfigOverrides,
  type Driver,
  CleanupReaper,
  Doctor,
  LeaseEngine,
  loadConfig,
  Registry,
  Nuke,
} from "../core/index.js";
import { AndroidDriver, SdkMissingError } from "../drivers/android/index.js";
import { IosSimctlDriver } from "../drivers/ios/index.js";
import {
  CryptoIdGenerator,
  type Clock,
  type Filesystem,
  type IdGenerator,
  type IpcConnector,
  type IpcListenerFactory,
  NodeFilesystem,
  NodeIpcTransport,
  NodeProcessRunner,
  NodeSystemStats,
  SystemClock,
  type SystemStats,
  type ProcessRunner,
} from "../ports/index.js";
import { DaemonServer } from "./server.js";
import { DaemonEndpointHost } from "./connection-host.js";

export interface StartDaemonOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly defaultRequesterId?: string;
  readonly drivers?: readonly Driver[];
  readonly filesystem?: Filesystem;
  readonly idGenerator?: IdGenerator;
  readonly ipc?: IpcConnector & IpcListenerFactory;
  readonly processRunner?: ProcessRunner;
  readonly socketPath?: string;
  readonly statePath?: string;
  readonly systemStats?: SystemStats;
  readonly version?: string;
}

/** Constructs the daemon's real adapters once; all state remains in the daemon. */
// fallow-ignore-next-line complexity -- explicit production composition necessarily wires all external ports.
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  const dataDirectory = options.dataDirectory ?? join(homedir(), ".pitlane");
  const filesystem = options.filesystem ?? new NodeFilesystem();
  const clock = options.clock ?? new SystemClock();
  const systemStats = options.systemStats ?? new NodeSystemStats();
  const idGenerator = options.idGenerator ?? new CryptoIdGenerator();
  const ipc = options.ipc ?? new NodeIpcTransport();
  const processRunner = options.processRunner ?? new NodeProcessRunner();
  const configPath = options.configPath ?? join(dataDirectory, "config.json");
  const statePath = options.statePath ?? join(dataDirectory, "state.json");
  const socketPath = options.socketPath ?? join(dataDirectory, "daemon.sock");
  const config = await loadConfig({
    configPath,
    filesystem,
    ...(options.configOverrides === undefined ? {} : { overrides: options.configOverrides }),
    systemStats,
  });
  const eventBus = new EventBus(clock, config.eventBuffer.capacity);
  const registry = await Registry.load({ clock, eventBus, filesystem, idGenerator, statePath });
  const drivers =
    options.drivers ?? (await discoverDrivers({ clock, filesystem, idGenerator, processRunner }));
  const leaseEngine = new LeaseEngine({
    clock,
    config,
    drivers,
    eventBus,
    idGenerator,
    registry,
    systemStats,
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: leaseEngine.cleanup,
    filesystem,
    registry,
    diskPath: dataDirectory,
  });
  const doctor = new Doctor({ clock, drivers, eventBus, leaseExpirer: leaseEngine, registry });
  const nuke = new Nuke({ executor: leaseEngine, registry });
  await doctor.reconcile();
  await leaseEngine.convergeRunningCapacity();
  const daemon = new DaemonServer({
    capacity: leaseEngine,
    catalog: leaseEngine,
    config,
    doctor,
    defaultRequesterId:
      options.defaultRequesterId ?? process.env.PITLANE_AGENT_ID ?? String(process.pid),
    eventBus,
    host: new DaemonEndpointHost({
      connector: ipc,
      endpoint: socketPath,
      filesystem,
      listenerFactory: ipc,
    }),
    leases: leaseEngine,
    queue: leaseEngine,
    reaper,
    nuke,
    registry,
    version: options.version ?? "1.0.0",
  });
  await daemon.start();
  return daemon;
}

async function discoverDrivers(options: {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly processRunner: ProcessRunner;
}): Promise<Driver[]> {
  const drivers: Driver[] = [];
  if (process.platform === "darwin") {
    drivers.push(
      new IosSimctlDriver({
        clock: options.clock,
        filesystem: options.filesystem,
        idGenerator: options.idGenerator,
        processRunner: options.processRunner,
      }),
    );
  }
  try {
    drivers.push(
      await AndroidDriver.create({
        clock: options.clock,
        env: process.env,
        filesystem: options.filesystem,
        homeDirectory: homedir(),
        idGenerator: options.idGenerator,
        processRunner: options.processRunner,
      }),
    );
    return drivers;
  } catch (error: unknown) {
    if (error instanceof SdkMissingError) {
      return drivers;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void startDaemon().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
