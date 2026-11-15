import { mkdtemp } from "node:fs/promises";
import { type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOnFreePort } from "../test-support/loopback-port.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import type { OptionalModuleDefinition } from "../modules/index.js";
import { type FakeModule } from "../modules/testing.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";

export const admin = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
} as const;

export const agent = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "agent-1",
  role: "agent",
} as const;

export const ios = {
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
  requesterId: "agent-1",
} as const;

export const daemons: DaemonServer[] = [];

export const directories: string[] = [];

export const servers: Server[] = [];

class NotingDriver extends FakeDriver {
  constructor(
    options: ConstructorParameters<typeof FakeDriver>[0],
    readonly notes: string[],
  ) {
    super(options);
  }

  // why: a released virtual device is destroyed, never reclaimed (ADR 0061).
  override async destroy(...args: Parameters<FakeDriver["destroy"]>) {
    this.notes.push("driver destroy");
    return super.destroy(...args);
  }

  async dispose(): Promise<void> {
    this.notes.push("driver dispose");
  }
}

export interface Rig {
  readonly daemon: DaemonServer;
  readonly clock: FakeClock;
  readonly sink: MemoryLogSink;
  readonly directory: string;
  readonly notes: string[];
  readonly origin: string | undefined;
  readonly driver: NotingDriver;
}

export interface RigOptions {
  readonly modules: readonly OptionalModuleDefinition<unknown>[];
  readonly on?: readonly string[];
  readonly http?: boolean;
  // why: agent-device's allocate names no model, so the driver must list a default phone for it.
  readonly phones?: boolean;
  readonly extra?: Partial<StartDaemonOptions>;
  readonly overrides?: Record<string, unknown>;
  readonly notes?: string[];
}

export function definitions(...modules: FakeModule[]): OptionalModuleDefinition<unknown>[] {
  return modules.map((module) => module.definition as OptionalModuleDefinition<unknown>);
}

export async function prepare(options: RigOptions, port?: number) {
  const directory = await mkdtemp(join(tmpdir(), "simlock-modules-"));
  directories.push(directory);
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const notes = options.notes ?? [];
  const driver = new NotingDriver(
    {
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      ...(options.phones === true
        ? {
            defaultModels: { phone: ["iPhone 16"] },
            knownModels: ["iPhone 16"],
            modelClasses: { "iPhone 16": "phone" as const },
          }
        : {}),
    },
    notes,
  );
  const startOptions = {
    clock,
    configOverrides: {
      capabilities: Object.fromEntries((options.on ?? []).map((name) => [name, { enabled: true }])),
      // why: a standalone worker serves HTTP by default (ADR 0046); a rig that asks for no HTTP pins it off.
      ...(port === undefined
        ? options.extra?.role === "gateway"
          ? {}
          : { http: { enabled: false } }
        : { http: { enabled: true, host: "127.0.0.1", port } }),
      ...options.overrides,
    },
    dataDirectory: directory,
    drivers: [driver],
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    optionalModules: options.modules,
    socketPath: join(directory, "daemon.sock"),
    deviceDataTables: fakeDeviceDataTables,
    version: "1.2.3",
    ...options.extra,
  } as StartDaemonOptions;
  return {
    clock,
    directory,
    driver,
    notes,
    origin: port === undefined ? undefined : `http://127.0.0.1:${String(port)}`,
    sink,
    startOptions,
  };
}

// why: `reset` empties what a test collects from its modules' hooks, so a start that lost its port and was stopped leaves nothing in it.
export async function start(options: RigOptions, reset?: () => void): Promise<Rig> {
  const { started } = await startOnFreePort(async (port) => {
    reset?.();
    const prepared = await prepare(options, options.http === true ? port : undefined);
    return { ...prepared, daemon: await startDaemon(prepared.startOptions) };
  });
  daemons.push(started.daemon);
  return started;
}

export async function agentHeaders(daemon: DaemonServer): Promise<Record<string, string>> {
  const { secret } = await daemon.dispatch("token.create", { label: "a", role: "agent" }, admin);
  return { authorization: `Bearer ${secret}` };
}

export async function leaseAndRelease(daemon: DaemonServer): Promise<string> {
  const grant = (await daemon.dispatch("lease.request", ios, agent)) as { lease: { id: string } };
  await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
  return grant.lease.id;
}
