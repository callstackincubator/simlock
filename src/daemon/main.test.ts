import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver } from "../core/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  CryptoIdGenerator,
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { discoverDrivers, startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function start(overrides: Partial<StartDaemonOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pitlane-main-"));
  temporaryDirectories.push(directory);
  const sink = new MemoryLogSink();
  const clock = new FakeClock(1_000);
  const logger = new JsonLinesLogger({ clock, level: "debug", sink });
  const daemon = await startDaemon({
    clock,
    dataDirectory: directory,
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    filesystem: new MemoryFilesystem(),
    logger,
    statePath: join(directory, "state.json"),
    version: "1.2.3",
    ...overrides,
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { daemon, sink };
}

describe("startDaemon", () => {
  it("writes a structured start record with version, protocol version, socket path, and effective config", async () => {
    const { daemon, sink } = await start();

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Daemon started",
        fields: expect.objectContaining({
          version: "1.2.3",
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          socketPath: daemon.socketPath,
        }),
      }),
    );
    const record = sink.records.find((entry) => entry.message === "Daemon started");
    expect(record?.fields?.config).toMatchObject({ log: { level: "info" } });
  });

  it("scopes child loggers under daemon.<module> so records are attributable", async () => {
    const { sink } = await start();

    const modules = new Set(sink.records.map((record) => record.module));
    expect(modules).toContain("daemon.server");
    expect(modules).toContain("daemon.connection-host");
  });
});

describe("discoverDrivers", () => {
  it("logs a skip when the Android SDK cannot be found, without throwing", async () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    const filesystem = new MemoryFilesystem();

    const drivers = await discoverDrivers({
      clock: new FakeClock(),
      filesystem,
      idGenerator: new CryptoIdGenerator(),
      logger,
      processRunner: new ScriptedProcessRunner([]),
    });

    expect(drivers.some((driver) => driver.platform === "android")).toBe(false);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Skipped Android driver: SDK missing",
        module: "daemon.driver-discovery",
      }),
    );
  });
});

describe("discoverDrivers with PITLANE_DRIVERS_MODULE", () => {
  const previousModule = process.env.PITLANE_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.PITLANE_DRIVERS_MODULE;
    } else {
      process.env.PITLANE_DRIVERS_MODULE = previousModule;
    }
  });

  async function writeModule(contents: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pitlane-drivers-module-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "drivers.mjs");
    await writeFile(modulePath, contents, "utf8");
    return modulePath;
  }

  async function discover(sink: MemoryLogSink) {
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    return discoverDrivers({
      clock: new FakeClock(),
      filesystem: new MemoryFilesystem(),
      idGenerator: new CryptoIdGenerator(),
      logger,
      processRunner: new ScriptedProcessRunner([]),
    });
  }

  it("substitutes discovery with the module's createDrivers(context), logging the substitution", async () => {
    process.env.PITLANE_DRIVERS_MODULE = await writeModule(
      `export function createDrivers(context) {
         return [{ platform: "ios", fromModule: true, sawContext: typeof context.logger === "object" }];
       }`,
    );
    const sink = new MemoryLogSink();

    const drivers = await discover(sink);

    expect(drivers).toEqual([{ platform: "ios", fromModule: true, sawContext: true }]);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Substituting driver discovery via PITLANE_DRIVERS_MODULE",
        module: "daemon.driver-discovery",
      }),
    );
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Loaded drivers from PITLANE_DRIVERS_MODULE",
        module: "daemon.driver-discovery",
        fields: expect.objectContaining({ count: 1 }),
      }),
    );
  });

  it("supports a synchronous createDrivers returning an array directly", async () => {
    process.env.PITLANE_DRIVERS_MODULE = await writeModule(
      `export function createDrivers() { return []; }`,
    );

    await expect(discover(new MemoryLogSink())).resolves.toEqual([]);
  });

  it("fails loudly when the module has no createDrivers export", async () => {
    process.env.PITLANE_DRIVERS_MODULE = await writeModule(`export const nope = 1;`);

    await expect(discover(new MemoryLogSink())).rejects.toThrow(/createDrivers/);
  });

  it("fails loudly when the module cannot be imported", async () => {
    process.env.PITLANE_DRIVERS_MODULE = join(
      tmpdir(),
      "pitlane-drivers-module-does-not-exist.mjs",
    );

    await expect(discover(new MemoryLogSink())).rejects.toThrow();
  });
});
