import { queryState } from "./test-main-state.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registryOwner } from "../core/index.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  fakeDeviceDataTables,
  loadTestRegistry,
} from "../core/testing.js";
import { openStateDatabase } from "../state/index.js";
import { androidDeviceDataTable } from "../drivers/android/index.js";
import { iosDeviceDataTable } from "../drivers/ios/index.js";
import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  IpcError,
  MemoryFilesystem,
  MemoryIpcTransport,
  NodeSqliteOpener,
  NoopLogger,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import { productionDeviceDataTables, resolveDeviceDataTables } from "./driver-discovery.js";
import {
  STANDALONE_OFF,
  runningDaemons,
  start,
  stopDaemons,
  temporaryDirectories,
  writeModule,
} from "./test-main.js";
import { startOnFreePort } from "../test-support/loopback-port.js";

afterEach(stopDaemons);

describe("startDaemon state.db", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  it.each([
    [
      "worker",
      "state.json",
      "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.",
    ],
    [
      "worker",
      "tokens.json",
      "with the older Simlock, release every lease and run `simlock nuke --delete-devices`; then remove <path> and start again.",
    ],
    [
      "gateway",
      "tokens.json",
      "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.",
    ],
    [
      "gateway",
      "workers.json",
      "remove <path> and start again; then create each worker's join token again with `simlock --gateway token create --role worker`, set it as that worker's `gateway.token`, and drain workers again.",
    ],
  ] as const)(
    "a %s started with %s in its folder refuses with the old-file message and its step",
    async (role, file, step) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-old-file-"));
      temporaryDirectories.push(directory);
      const oldFile = join(directory, file);
      await writeFile(oldFile, "[]", "utf8");

      await expect(start({ dataDirectory: directory, role })).rejects.toMatchObject({
        message: `Found ${oldFile}, which this Simlock no longer reads. To upgrade: ${step.replace("<path>", oldFile)} See https://incubator.callstack.com/simlock/docs/worker/daemon#from-a-version-that-used-statejson.`,
      });
      expect(existsSync(join(directory, "state.db"))).toBe(false);
    },
  );

  it("a token created, then the daemon restarted on the same state.db, verifies and lists with every field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-token-restart-"));
    temporaryDirectories.push(directory);
    const admin = {
      manageEventSubscription: () => undefined,
      principal: "admin",
      role: "admin",
      via: "socket",
    } as const;
    let port = 0;
    const launch = async (now: number) => {
      const launched = await startOnFreePort((candidate) =>
        startDaemon({
          clock: new FakeClock(now),
          configOverrides: {
            ...STANDALONE_OFF,
            http: { enabled: true, host: "127.0.0.1", port: candidate },
          },
          dataDirectory: directory,
          deviceDataTables: fakeDeviceDataTables,
          drivers: [],
          hostLoadProbe: null,
          version: "1.2.3",
        } as StartDaemonOptions),
      );
      port = launched.port;
      return launched.started;
    };
    type Created = { readonly secret: string; readonly token: Record<string, unknown> };
    const first = await launch(1_000);
    const labelled = (await first.dispatch(
      "token.create",
      { label: "ci", role: "agent" },
      admin,
    )) as Created;
    const bare = (await first.dispatch("token.create", { role: "operator" }, admin)) as Created;
    await first.stop();

    const second = await launch(2_000);
    runningDaemons.push(second);

    const listed = (await second.dispatch("token.list", {}, admin)) as {
      readonly tokens: readonly Record<string, unknown>[];
    };
    expect(listed.tokens).toEqual([labelled.token, bare.token]);
    expect("label" in (listed.tokens[1] ?? {})).toBe(false);

    const statusWith = async (secret: string) =>
      (
        await fetch(`http://127.0.0.1:${port}/v1/status`, {
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status;
    expect(await statusWith(labelled.secret)).toBe(200);
    expect(await statusWith(bare.secret)).toBe(200);
    expect(await statusWith("slk_not-a-created-secret")).toBe(401);
  });

  it("a start that fails after state.db opened closes it before it throws", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-closes-state-"));
    temporaryDirectories.push(directory);
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    const previous = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "1" },
      state,
    });
    await previous.registerDevice({
      driverData: { fakeDeviceId: "fk-1" },
      driverDeviceId: "drv-1",
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
    });
    state.database.exec("DELETE FROM fake_device_data");
    state.close();
    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);

    await expect(start({ dataDirectory: directory })).rejects.toMatchObject({
      name: "RegistryLoadError",
    });

    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);
  });

  it("a worker drops a deleted device record older than the configured devices.deletedRetentionMs at start", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-deleted-retention-"));
    temporaryDirectories.push(directory);
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    const previous = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "1" },
      state,
    });
    const device = await previous.registerDevice({
      driverData: { fakeDeviceId: "fk-1" },
      driverDeviceId: "drv-1",
      provisionDuration: 0,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
    });
    await previous.markDeviceMissing(device.id, "doctor");
    state.close();
    // why: 30 minutes is inside the default hour and outside the ten minutes configured below.
    clock.advance(30 * 60_000);

    await start({
      clock,
      configOverrides: { devices: { deletedRetentionMs: 600_000 } },
      dataDirectory: directory,
    });

    expect(await queryState(directory, "SELECT id FROM devices")).toEqual([]);
  });

  it("a worker refuses a re-sent chosen lease id inside the configured lease.endedIdRetentionMs and grants it after", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const { daemon } = await start({
      clock,
      configOverrides: { lease: { endedIdRetentionMs: 600_000 } },
      drivers: [driver],
    });
    const agent = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "agent",
      role: "agent",
    } as const;
    const chosen = {
      leaseId: "retained",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      requesterId: "agent-1",
    } as const;
    await daemon.dispatch("lease.request", chosen, agent);
    await daemon.dispatch("lease.release", { leaseId: "retained" }, agent);

    // why: 5 minutes is inside the ten minutes configured and far inside the default day.
    clock.advance(5 * 60_000);
    await expect(daemon.dispatch("lease.request", chosen, agent)).rejects.toMatchObject({
      code: "LEASE_ENDED",
    });
    // why: 30 minutes is outside the ten minutes configured and inside the default day.
    clock.advance(30 * 60_000);
    await expect(daemon.dispatch("lease.request", chosen, agent)).resolves.toMatchObject({
      lease: { id: "retained" },
    });
  });

  it("a worker's state.db holds both platforms' source-data tables, a gateway's holds neither", async () => {
    const worker = await mkdtemp(join(tmpdir(), "simlock-main-source-owners-"));
    const gateway = await mkdtemp(join(tmpdir(), "simlock-main-source-owners-"));
    temporaryDirectories.push(worker, gateway);
    await start({ dataDirectory: worker });
    await start({ dataDirectory: gateway, role: "gateway" });
    const owners = async (directory: string) =>
      (await queryState(directory, "SELECT owner FROM schema_versions"))
        .map((row) => row["owner"])
        .filter((owner) => owner === "ios-source-data" || owner === "android-source-data")
        .sort();

    expect(await owners(worker)).toEqual(["android-source-data", "ios-source-data"]);
    expect(await owners(gateway)).toEqual([]);
  });

  it("a second startDaemon on a folder whose daemon runs leaves state.db's schema_versions and bytes unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-live-state-"));
    temporaryDirectories.push(directory);
    await start({ dataDirectory: directory });
    const versions = () => queryState(directory, "SELECT owner, version FROM schema_versions");
    const before = await versions();
    const bytesBefore = await readFile(join(directory, "state.db"));
    // why: a newer binary brings a newer version of an owner the live daemon's state.db has; opening would migrate it in.
    const newerTable = {
      ...fakeDeviceDataTable,
      migrations: [
        ...fakeDeviceDataTable.migrations,
        "CREATE TABLE newer_fake_data (id TEXT) STRICT",
      ],
      version: 2,
    };

    await expect(
      start({
        dataDirectory: directory,
        deviceDataTables: new Map([["ios", newerTable]]),
      }),
    ).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });

    expect(await versions()).toEqual(before);
    expect(await readFile(join(directory, "state.db"))).toEqual(bytesBefore);
  });

  it("refuses to start as already running when connecting to its endpoint times out, as a Windows pipe whose every instance is busy does", async () => {
    const memory = new MemoryIpcTransport();
    const ipc = {
      connect: async () => {
        throw new IpcError("connection-timeout", "timed out", undefined);
      },
      listen: memory.listen.bind(memory),
    };

    await expect(start({ ipc })).rejects.toMatchObject({ name: "DaemonAlreadyRunningError" });
  });

  it("a SIMLOCK_DRIVERS_MODULE without a deviceDataTables export fails start naming it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-no-tables-"));
    temporaryDirectories.push(directory);
    const modulePath = join(directory, "drivers.mjs");
    await writeFile(modulePath, "export function createDrivers() { return []; }\n", "utf8");
    process.env.SIMLOCK_DRIVERS_MODULE = modulePath;

    await expect(
      start({ dataDirectory: directory, deviceDataTables: undefined, drivers: undefined }),
    ).rejects.toMatchObject({
      message: `SIMLOCK_DRIVERS_MODULE ${modulePath} does not export deviceDataTables, a Map from platform to its device-data table`,
    });
    expect(existsSync(join(directory, "state.db"))).toBe(false);
  });

  it("resolveDeviceDataTables answers the option's map when given, else the drivers module's export, else the production map", async () => {
    expect(await resolveDeviceDataTables({ deviceDataTables: fakeDeviceDataTables })).toBe(
      fakeDeviceDataTables,
    );

    // why: the module exports tables of its own, so a module checked first would answer a different map.
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      "export function createDrivers() { return []; }",
    );
    const optionMap = new Map(fakeDeviceDataTables);
    expect(await resolveDeviceDataTables({ deviceDataTables: optionMap })).toBe(optionMap);

    delete process.env.SIMLOCK_DRIVERS_MODULE;
    const production = await resolveDeviceDataTables({});
    expect(production).toEqual(productionDeviceDataTables());
    expect(production.get("ios")).toBe(iosDeviceDataTable);
    expect(production.get("android")).toBe(androidDeviceDataTable);

    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      "export function createDrivers() { return []; }",
    );
    const fromModule = await resolveDeviceDataTables({});
    expect([...fromModule.keys()].sort()).toEqual(["android", "ios"]);
    expect(fromModule.get("ios")?.name).toBe("fake-device-data");
    expect(fromModule).not.toBe(fakeDeviceDataTables);
  });
});
