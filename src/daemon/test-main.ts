import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import { freeLoopbackPort } from "./test-relay-support.js";
import type { DaemonServer } from "./server.js";

export const runningDaemons: DaemonServer[] = [];

export const temporaryDirectories: string[] = [];

// why: a standalone worker serves HTTP and agent-device by default (ADR 0046); a test that asks for neither pins them off, and two daemons would clash on port 4701.
export const STANDALONE_OFF = {
  capabilities: { "agent-device": { enabled: false } },
  http: { enabled: false },
} as const;

export async function start(
  overrides: Partial<Omit<StartDaemonOptions, "deviceDataTables" | "drivers">> & {
    readonly deviceDataTables?: StartDaemonOptions["deviceDataTables"] | undefined;
    readonly drivers?: StartDaemonOptions["drivers"] | undefined;
  } = {},
) {
  const { configOverrides, ...rest } = overrides;
  const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
  temporaryDirectories.push(directory);
  const sink = new MemoryLogSink();
  const clock = new FakeClock(1_000);
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  // why: a gateway without an http override binds the default port 4700, which a real gateway on the host may hold.
  const gatewayDefaults =
    overrides.role === "gateway"
      ? { http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() } }
      : {};
  const daemon = await startDaemon({
    clock,
    dataDirectory: directory,
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    deviceDataTables: fakeDeviceDataTables,
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    logger,
    version: "1.2.3",
    ...rest,
    configOverrides:
      overrides.role === "gateway"
        ? { ...gatewayDefaults, ...configOverrides }
        : { ...STANDALONE_OFF, ...configOverrides },
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { daemon, directory, sink };
}

// why: a drivers module must export the device-data tables of its platforms, and the module file
// cannot import the repo's TypeScript, so this is the fake driver's table spelled out in plain JS.
const MODULE_DEVICE_DATA_TABLES = `
const table = {
  migrations: [
    "CREATE TABLE fake_device_data (device_id TEXT PRIMARY KEY, fake_device_id TEXT NOT NULL) STRICT",
  ],
  name: "fake-device-data",
  read(database, deviceId) {
    const row = database
      .prepare("SELECT fake_device_id FROM fake_device_data WHERE device_id = ?")
      .get(deviceId);
    if (row === undefined) throw new Error("No fake driver data for device " + deviceId);
    return { fakeDeviceId: row.fake_device_id };
  },
  version: 1,
  write(database, deviceId, driverData) {
    database
      .prepare(
        "INSERT INTO fake_device_data (device_id, fake_device_id) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET fake_device_id = excluded.fake_device_id",
      )
      .run(deviceId, driverData.fakeDeviceId);
  },
};
export const deviceDataTables = new Map([["android", table], ["ios", table]]);
`;

export async function writeModule(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-drivers-module-"));
  temporaryDirectories.push(directory);
  const modulePath = join(directory, "drivers.mjs");
  await writeFile(modulePath, `${contents}\n${MODULE_DEVICE_DATA_TABLES}`, "utf8");
  return modulePath;
}

export async function pollUntilListening(port: number, secret: string): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      return await response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("HTTP gateway never started listening");
}

export const SIMLOCK_HOME = "/home/.simlock";

export interface MinimalClient {
  readonly socket: import("node:net").Socket;
  request(
    type: string,
    payload: unknown,
  ): Promise<{ readonly ok: boolean; readonly payload?: unknown }>;
}

function connectClient(socketPath: string): Promise<MinimalClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let nextId = 1;
    const waiters = new Map<string, (frame: { ok: boolean; payload?: unknown }) => void>();
    socket.once("connect", () => {
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const frame = JSON.parse(line) as { id?: string; ok: boolean; payload?: unknown };
          if (typeof frame.id === "string") {
            waiters.get(frame.id)?.(frame);
            waiters.delete(frame.id);
          }
        }
      });
      resolve({
        socket,
        request: (type, payload) =>
          new Promise((resolveRequest) => {
            const id = `req-${String(nextId)}`;
            nextId += 1;
            waiters.set(id, resolveRequest);
            socket.write(`${JSON.stringify({ id, payload, type })}\n`);
          }),
      });
    });
    socket.once("error", reject);
  });
}

export async function connectRetrying(
  socketPath: string,
  timeoutMs = 2_000,
): Promise<MinimalClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connectClient(socketPath);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export async function pollUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function startGateway(
  overrides: Partial<StartDaemonOptions> & { readonly directory?: string } = {},
) {
  const { directory: given, ...rest } = overrides;
  const directory = given ?? (await mkdtemp(join(tmpdir(), "simlock-main-gw-load-")));
  if (given === undefined) temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const daemon = await startDaemon({
    clock,
    configOverrides: {
      http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
    },
    role: "gateway",
    dataDirectory: directory,
    drivers: [],
    filesystem: new MemoryFilesystem(),
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    version: "1.2.3",
    ...rest,
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { clock, daemon, directory };
}

export async function stopDaemons(): Promise<void> {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
}
