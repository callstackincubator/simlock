import { fakeDirectoryAccess } from "../test-support/directory-access.js";
import { hasEvent, historyEventsWhen } from "./test-main-history.js";
import { queryState } from "./test-main-state.js";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriverCrashError, registryOwner, baselinesOwner } from "../core/index.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  fakeDeviceDataTables,
  loadTestRegistry,
} from "../core/testing.js";
import { openStateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import {
  FakeClock,
  FakeHostInfo,
  FakeSystemStats,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeSqliteOpener,
  NoopLogger,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import {
  STANDALONE_OFF,
  runningDaemons,
  start,
  stopDaemons,
  temporaryDirectories,
} from "./test-main.js";

afterEach(stopDaemons);

describe("startDaemon wires core and leasing together", () => {
  const agent = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "agent",
    role: "agent",
  } as const;
  const admin = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "operator",
    role: "admin",
  } as const;
  const ios = {
    model: "iPhone 16",
    osVersion: "26.5",
    platform: "ios",
    requesterId: "agent-1",
  } as const;
  type Grant = {
    readonly lease: { readonly id: string };
    readonly device: { readonly id: string };
  };

  /** why: Lets the work a mutated daemon would still be doing finish, so "nothing happened" is a
   * statement about the daemon and not about how early the test looked. Only sound when that
   * work is all in memory: a timer fires after it however loaded the machine is, but real I/O
   * (a process spawn, a real file) can outlast it. */
  const settleRealTime = async () => new Promise<void>((resolve) => setTimeout(resolve, 25));

  async function leasedIos(options: ConstructorParameters<typeof FakeDriver>[0]) {
    const clock = options.clock as FakeClock;
    const driver = new FakeDriver(options);
    const filesystem = new MemoryFilesystem();
    const started = await start({ clock, drivers: [driver], filesystem });
    const grant = (await started.daemon.dispatch("lease.request", ios, agent)) as Grant;
    return { ...started, clock, driver, filesystem, grant };
  }

  it("runs the operator reset through core's nuke, which releases the lease through leasing", async () => {
    const clock = new FakeClock(1_000);
    const { daemon, grant } = await leasedIos({
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
    });

    const report = await daemon.dispatch("nuke.run", { deleteDevices: true }, admin);

    expect(report).toEqual({
      deletedDevices: [grant.device.id],
      releasedLeaseIds: [grant.lease.id],
      removedBaselines: [],
    });
  });

  it("runs the operator's warm.forget through core's warm pool, which answers the kinds it forgot", async () => {
    const { daemon } = await start();

    const report = await daemon.dispatch(
      "warm.forget",
      { model: "iPhone 17 Pro", platform: "ios" },
      admin,
    );

    expect(report).toEqual({ forgotten: [] });
  });

  it("grants a waiting physical request once device.add enrolls a second device of the model", async () => {
    const clock = new FakeClock(1_000);
    const phone = { apps: [], class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" } as const;
    const driver = new FakeDriver({
      clock,
      physicalDevices: [
        { ...phone, ids: ["UDID-A"] },
        { ...phone, ids: ["UDID-B"] },
      ],
      platform: "ios",
    });
    driver.setPhysicalPresence("UDID-A", true);
    driver.setPhysicalPresence("UDID-B", true);
    const { daemon } = await start({ clock, drivers: [driver] });
    const physical = { model: "iPhone 15 Pro", physical: true, platform: "ios" } as const;
    await daemon.dispatch("device.add", { id: "UDID-A", platform: "ios" }, admin);
    await daemon.dispatch("lease.request", { ...physical, requesterId: "agent-1" }, agent);
    const waiting = daemon.dispatch(
      "lease.request",
      { ...physical, requesterId: "agent-2" },
      agent,
    ) as Promise<Grant>;
    await settleRealTime();

    await daemon.dispatch("device.add", { id: "UDID-B", platform: "ios" }, admin);

    const outcome = await Promise.race([waiting, settleRealTime().then(() => "still waiting")]);
    expect(outcome).toMatchObject({ device: { physical: true } });
  });

  it("status.get carries the presence the grant's read found on a physical device, through the daemon's own wiring", async () => {
    const clock = new FakeClock(1_000);
    const phone = { apps: [], class: "phone", model: "iPhone 15 Pro", osVersion: "18.4" } as const;
    const driver = new FakeDriver({
      clock,
      physicalDevices: [{ ...phone, ids: ["UDID-WIRED-PRESENCE"] }],
      platform: "ios",
    });
    driver.setPhysicalPresence("UDID-WIRED-PRESENCE", true);
    const { daemon } = await start({ clock, drivers: [driver] });
    await daemon.dispatch("device.add", { id: "UDID-WIRED-PRESENCE", platform: "ios" }, admin);
    await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15 Pro", physical: true, platform: "ios", requesterId: "agent-1" },
      agent,
    );

    const status = (await daemon.dispatch("status.get", {}, agent)) as {
      devices?: { driverDeviceId?: string; presence?: unknown }[];
    };

    const entry = status.devices?.find((device) => device.driverDeviceId === "UDID-WIRED-PRESENCE");
    expect(entry).toMatchObject({ presence: { present: true } });
  });

  it("starts a device.exec child from the allowlisted keys of the daemon's environment plus the command's own env, without a secret the daemon inherited", async () => {
    const clock = new FakeClock(1_000);
    const runner = new ScriptedProcessRunner([
      { match: { args: ["list", "devices"], command: "fake-simctl" } },
    ]);
    const driver = new FakeDriver({
      availableOsVersions: ["26.5"],
      clock,
      passthrough: () => ({
        args: ["list", "devices"],
        command: "fake-simctl",
        env: { SIMLOCK_SCOPED: "1" },
      }),
      passthroughTools: ["simctl"],
      platform: "ios",
    });
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "aws-secret");
    vi.stubEnv("LC_CTYPE", "simlock-test-locale");
    try {
      const { daemon } = await start({
        clock,
        drivers: [driver],
        hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
        processRunner: runner,
      });
      const grant = (await daemon.dispatch("lease.request", ios, agent)) as Grant;

      await daemon.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: grant.lease.id, tool: "simctl" },
        agent,
      );

      const env = runner.calls.find((call) => call.command === "fake-simctl")?.options.env;
      expect(env).toMatchObject({ LC_CTYPE: "simlock-test-locale", SIMLOCK_SCOPED: "1" });
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("announces the capacity figures and then the queue depth once startup is done", async () => {
    const { directory } = await start();

    const events = await historyEventsWhen(directory, hasEvent("queue.changed"));
    const names = events.map((event) => event.event);

    expect(names.indexOf("capacity.changed")).toBeGreaterThan(-1);
    expect(names.indexOf("queue.changed")).toBeGreaterThan(names.indexOf("capacity.changed"));
    expect(events.find((event) => event.event === "queue.changed")?.module).toBe("wait-queue");
  });

  it("runs doctor's startup pass on the startup read before core's device steps announce the capacity figures", async () => {
    const { directory } = await start();

    const names = (await historyEventsWhen(directory, hasEvent("capacity.changed"))).map(
      (event) => event.event,
    );

    expect(names.indexOf("doctor.reconciled")).toBeGreaterThan(-1);
    expect(names.indexOf("doctor.reconciled")).toBeLessThan(names.indexOf("capacity.changed"));
  });

  it("marks a saved baseline whose runtime is gone as stale at start, before anything lists baselines", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable, baselinesOwner],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    state.database
      .prepare(
        "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES ('login', 1, 'ios', 'iPhone 17 Pro', '26.5', 'full', '2026-11-02T13:40:00.000Z', 'src-login')",
      )
      .run();
    state.close();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.setSources([
      {
        id: "src-login",
        kind: "baseline",
        model: "iPhone 17 Pro",
        osVersion: "26.5",
        staleReason: reason,
      },
    ]);

    const daemon = await startDaemon({
      hostLoadProbe: null,
      directoryAccess: fakeDirectoryAccess(),
      clock,
      configOverrides: STANDALONE_OFF,
      dataDirectory: directory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [driver],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);

    const stale = await historyEventsWhen(directory, hasEvent("baseline.stale"));
    expect(
      stale.filter((event) => event.event === "baseline.stale").map((event) => event.payload),
    ).toEqual([{ name: "login", reason, version: 1 }]);
  });

  it("settles the requests a restart left open before core's device steps announce the capacity figures", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
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
    await previous.createLeaseRequest({
      ownerId: "agent-1",
      request: ios,
      requesterId: "agent-1",
    });
    state.close();

    const daemon = await startDaemon({
      hostLoadProbe: null,
      directoryAccess: fakeDirectoryAccess(),
      clock,
      configOverrides: STANDALONE_OFF,
      dataDirectory: directory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
      filesystem: new MemoryFilesystem(),
      logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
      version: "1.2.3",
    });
    runningDaemons.push(daemon);

    const names = (await historyEventsWhen(directory, hasEvent("capacity.changed"))).map(
      (event) => event.event,
    );
    expect(names.indexOf("lease.rejected")).toBeGreaterThan(-1);
    expect(names.indexOf("capacity.changed")).toBeGreaterThan(names.indexOf("lease.rejected"));
  });

  it("ends the lease whose device is not running before core's device steps announce capacity, so a restart no longer holds it", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const options = () =>
      ({
        hostLoadProbe: null,
        directoryAccess: fakeDirectoryAccess(),
        clock,
        configOverrides: STANDALONE_OFF,
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
        filesystem: new MemoryFilesystem(),
        logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
        // why: capacity follows the host's cpus and memory, and a small runner has too few slots for three leases at once, so a later request waits for ever on the fake clock (30 s timeout in runs 39459769408 and 39457371326).
        systemStats: new FakeSystemStats({ cpuCount: 16, totalRamBytes: 64 * 1024 ** 3 }),
        version: "1.2.3",
      }) as StartDaemonOptions;
    const first = await startDaemon(options());
    // why: several leases, so a reconcile that runs beside core's steps lands some releases after the announcement.
    const grants: Grant[] = [];
    for (const requesterId of ["agent-1", "agent-2", "agent-3"]) {
      grants.push((await first.dispatch("lease.request", { ...ios, requesterId }, agent)) as Grant);
    }
    await first.stop("test");
    // why: the history orders events by their time, and the second start's must follow the first's.
    clock.advance(1);
    const secondRunStart = clock.now();

    const daemon = await startDaemon(options());
    runningDaemons.push(daemon);

    const leases = (await daemon.dispatch("list.get", { kind: "leases" }, admin)) as readonly {
      readonly id: string;
    }[];
    for (const grant of grants) {
      expect(leases.map((lease) => lease.id)).not.toContain(grant.lease.id);
    }
    const secondRun = (
      await historyEventsWhen(directory, (all) =>
        all.some(
          (event) => event.event === "capacity.changed" && event.timestamp >= secondRunStart,
        ),
      )
    )
      .filter((event) => event.timestamp >= secondRunStart)
      .sort((left, right) => left.seq - right.seq)
      .map((event) => event.event);
    expect(secondRun.filter((name) => name === "lease.released")).toHaveLength(grants.length);
    expect(secondRun.lastIndexOf("lease.released")).toBeLessThan(
      secondRun.indexOf("capacity.changed"),
    );
    // why: two daemon starts and a history wait of up to 4 s outrun the 5 s default on a loaded CI runner (run 39454292501 timed out at 5015 ms, 59 ms locally).
  }, 30_000);

  it("closes state.db on stop, and lists the same device and lease after a worker is stopped and started again", async () => {
    const clock = new FakeClock(1_000);
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const options = () =>
      ({
        hostLoadProbe: null,
        directoryAccess: fakeDirectoryAccess(),
        clock,
        configOverrides: STANDALONE_OFF,
        dataDirectory: directory,
        deviceDataTables: fakeDeviceDataTables,
        drivers: [driver],
        filesystem: new MemoryFilesystem(),
        logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
        version: "1.2.3",
      }) as StartDaemonOptions;
    const first = await startDaemon(options());
    const grant = (await first.dispatch("lease.request", ios, agent)) as Grant;
    const list = async (daemon: Awaited<ReturnType<typeof startDaemon>>, kind: string) =>
      (
        (await daemon.dispatch("list.get", { kind }, admin)) as readonly { readonly id: string }[]
      ).map((row) => row.id);
    const devicesBefore = await list(first, "devices");
    await first.stop("test");
    // why: closing the last connection checkpoints and removes the WAL, so a stop that left state.db open leaves it.
    expect(existsSync(join(directory, "state.db-wal"))).toBe(false);

    const daemon = await startDaemon(options());
    runningDaemons.push(daemon);

    expect(devicesBefore).toContain(grant.device.id);
    expect(await list(daemon, "devices")).toEqual(devicesBefore);
    expect(await list(daemon, "leases")).toEqual([grant.lease.id]);
  });

  it("holds shutdown open while a release's erase runs, and does not read that erase as a stall", async () => {
    const clock = new FakeClock(1_000);
    const { daemon, driver, grant } = await leasedIos({
      availableOsVersions: ["26.5"],
      clock,
      latencyMs: { destroy: 600_000 },
      platform: "ios",
    });
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
    await settleRealTime();

    clock.advance(300_000);
    const devices = (await daemon.dispatch("list.get", { kind: "devices" }, admin)) as readonly {
      readonly id: string;
      readonly state: string;
      readonly stalled?: true;
    }[];
    expect(devices.map(({ id, state, stalled }) => ({ id, state, stalled }))).toEqual([
      { id: grant.device.id, state: "shutdown", stalled: undefined },
    ]);

    let stopped = false;
    const stopping = daemon.stop("test").then(() => {
      stopped = true;
    });
    await settleRealTime();
    expect(stopped).toBe(false);
    clock.advance(300_000);
    await stopping;
    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  it("cancels the expiry timer of an outstanding lease on shutdown, so nothing expires after it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const { daemon, directory } = await start({ clock, drivers: [driver] });
    await daemon.dispatch("lease.request", { ...ios, ttlMs: 10_000 }, agent);
    const leaseIds = async () =>
      (await queryState(directory, "SELECT id FROM leases")).map((row) => row.id);
    const before = await leaseIds();
    expect(before).toHaveLength(1);

    await daemon.stop("test");
    clock.advance(10_000);
    await settleRealTime();

    expect(await leaseIds()).toEqual(before);
  });

  it("cancels the quarantine retry timer on shutdown, so no retry runs after it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
    const started = await start({ clock, drivers: [driver] });
    const grant = (await started.daemon.dispatch("lease.request", ios, agent)) as Grant;
    await started.daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);

    await started.daemon.stop("test");
    clock.advance(30_000);
    await settleRealTime();

    expect(driver.calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  describe("a device quarantined by a failed delete", () => {
    type CauseView = {
      readonly id: string;
      readonly quarantineCause?: { readonly kind: string; readonly message?: string };
      readonly state: string;
    };

    async function quarantinedAfterFailedPurge() {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      driver.failOn("destroy", 1, new DriverCrashError("purge exploded"));
      const { daemon } = await start({
        clock,
        configOverrides: { warmPool: { enabled: false } },
        drivers: [driver],
      });
      const grant = (await daemon.dispatch("lease.request", ios, agent)) as Grant;
      await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
      await settleRealTime();
      return daemon;
    }

    const devicesOf = async (
      daemon: Awaited<ReturnType<typeof quarantinedAfterFailedPurge>>,
      session: typeof agent | typeof admin,
    ) =>
      (
        (await daemon.dispatch("status.get", {}, session)) as {
          readonly devices: readonly CauseView[];
        }
      ).devices;

    it("shows quarantineCause delete-failed with the driver's error in status.get and list.get", async () => {
      const daemon = await quarantinedAfterFailedPurge();

      const status = await devicesOf(daemon, admin);
      const listed = (await daemon.dispatch(
        "list.get",
        { kind: "devices" },
        admin,
      )) as readonly CauseView[];

      for (const devices of [status, listed]) {
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ state: "quarantined" });
        expect(devices[0]?.quarantineCause).toEqual({
          kind: "delete-failed",
          message: "DriverCrashError: purge exploded",
        });
      }
    });
  });

  it("probes a leased device again as time passes once startup is done", async () => {
    const clock = new FakeClock(1_000);
    const { driver } = await leasedIos({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const probesBefore = driver.calls.filter((call) => call.operation === "listManaged").length;

    clock.advance(30_000);
    await settleRealTime();

    expect(driver.calls.filter((call) => call.operation === "listManaged").length).toBeGreaterThan(
      probesBefore,
    );
  });
});
