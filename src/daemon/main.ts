import { homedir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../bus/index.js";
import {
  type ConfigOverrides,
  type Driver,
  CleanupReaper,
  LeaseEngine,
  loadConfig,
  Registry,
} from "../core/index.js";
import {
  CryptoIdGenerator,
  type Clock,
  type Filesystem,
  type IdGenerator,
  NodeFilesystem,
  NodeSystemStats,
  SystemClock,
  type SystemStats,
} from "../ports/index.js";
import { DaemonServer } from "./server.js";

export interface StartDaemonOptions {
  readonly clock?: Clock;
  readonly configOverrides?: ConfigOverrides;
  readonly configPath?: string;
  readonly dataDirectory?: string;
  readonly defaultRequesterId?: string;
  readonly drivers?: readonly Driver[];
  readonly filesystem?: Filesystem;
  readonly idGenerator?: IdGenerator;
  readonly socketPath?: string;
  readonly statePath?: string;
  readonly systemStats?: SystemStats;
  readonly version?: string;
}

/** Constructs the daemon's real adapters once; all state remains in the daemon. */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonServer> {
  const dataDirectory = options.dataDirectory ?? join(homedir(), ".pitlane");
  const filesystem = options.filesystem ?? new NodeFilesystem();
  const clock = options.clock ?? new SystemClock();
  const systemStats = options.systemStats ?? new NodeSystemStats();
  const idGenerator = options.idGenerator ?? new CryptoIdGenerator();
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
  const drivers = options.drivers ?? [];
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
    filesystem,
    leaseEngine,
    registry,
    diskPath: dataDirectory,
  });
  const daemon = new DaemonServer({
    config,
    defaultRequesterId: options.defaultRequesterId ?? String(process.pid),
    drivers,
    eventBus,
    filesystem,
    leaseEngine,
    reaper,
    registry,
    socketPath,
    version: options.version ?? "1.0.0",
  });
  await daemon.start();
  return daemon;
}
