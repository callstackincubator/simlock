import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer, Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registryOwner } from "../core/index.js";
import {
  FakeDriver,
  fakeDeviceDataTable,
  fakeDeviceDataTables,
  loadTestRegistry,
} from "../core/testing.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { openStateDatabase } from "../state/index.js";
import { EventBus } from "../bus/index.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeSqliteOpener,
  NoopLogger,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import {
  STANDALONE_OFF,
  connectRetrying,
  pollUntilListening,
  runningDaemons,
  start,
  stopDaemons,
  temporaryDirectories,
} from "./test-main.js";
import {
  freeLoopbackPort,
  portLostIn,
  startOnFreePort,
  startUnlessPortLost,
} from "../test-support/loopback-port.js";

afterEach(stopDaemons);

describe("startDaemon stopped while starting", () => {
  it("arms no timer when the startup read finishes after a stop, so nothing keeps the process alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-stop-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
    const filesystem = new MemoryFilesystem();
    const startPromise = startDaemon({
      clock,
      configOverrides: STANDALONE_OFF,
      dataDirectory: directory,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["26.5"],
          clock,
          latencyMs: { listManaged: 30_000 },
          platform: "ios",
        }),
      ],
      deviceDataTables: fakeDeviceDataTables,
      filesystem,
      hostLoadProbe: null,
      socketPath,
      version: "1.2.3",
    });

    const client = await connectRetrying(socketPath);
    try {
      const secret = (await readFileRetrying(filesystem, join(directory, "admin.token"))).trim();
      await client.request("hello", {
        clientVersion: "test",
        credential: secret,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      expect((await client.request("daemon.stop", {})).ok).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    } finally {
      client.socket.end();
    }
    clock.advance(30_000);
    await startPromise;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(clock.pendingTimerCount).toBe(0);
  });
});

describe("startDaemon HTTP gateway startup readiness", () => {
  it("parks an HTTP request until convergence completes, instead of refusing the connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const filesystem = new MemoryFilesystem();
    const secret = "slk_test_agent";
    await seedTokensDatabase(directory, [["tok_agent", secret, "agent"]]);
    await startOnFreePort(async (port) => {
      const sink = new MemoryLogSink();
      const startPromise = startDaemon({
        clock,
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock,
            latencyMs: { listManaged: 30_000 },
            platform: "ios",
          }),
        ],
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger: new JsonLinesLogger({ clock, level: "debug", sink }),
        version: "1.2.3",
      } as StartDaemonOptions).then((daemon) => {
        runningDaemons.push(daemon);
        return daemon;
      });
      void startPromise.catch(() => undefined);

      // why: Polls rather than a fixed delay: the gateway binds asynchronously (`onSocketClaimed`
      // fires once the socket claim resolves, then `gateway.start()` itself awaits a real
      // `listen()`), so there is no single microtask boundary to await here the way the
      // socket-side test above can just retry-connect on the unix socket.
      const watch = new AbortController();
      const statusBeforeConvergence = await Promise.race([
        pollUntilListening(port, secret),
        // why: a start that lost the port stays pending behind the convergence it waits for, so the loss is read from the daemon's log and the attempt runs again.
        portLostIn(sink, watch.signal),
      ]).finally(() => watch.abort());
      expect(statusBeforeConvergence).toMatchObject({ daemon: { health: "starting" } });

      const parkedStatusPromise = fetch(`http://127.0.0.1:${port}/v1/leases`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      let settled = false;
      void parkedStatusPromise.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      clock.advance(30_000);
      const daemon = await startPromise;
      expect(daemon).toBeDefined();

      const parkedResponse = await parkedStatusPromise;
      expect(parkedResponse.status).toBe(200);
    });
  });
});

describe("startDaemon stop with a cleanup run in flight (#985)", () => {
  const turnOfTheEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  it.each([
    { name: "the run daemon.started began", request: undefined },
    { name: "a dry run a client asked for", request: { dryRun: true } },
    { name: "a rule-scoped run a client asked for", request: { rule: "idle-destroy" } },
  ])(
    "logs no warning or error once a stop lands while $name is still in flight",
    async ({ request }) => {
      // why: holds a cleanup run on its disk read, so the stop lands while the run is in flight,
      // as an `http-start-failed` stop right after a start does.
      class HeldDiskFree extends MemoryFilesystem {
        readonly held: (() => void)[] = [];
        override async diskFree(path: string): Promise<number> {
          await new Promise<void>((resolve) => this.held.push(resolve));
          return super.diskFree(path);
        }
      }
      const filesystem = new HeldDiskFree();
      const { daemon, sink } = await start({ filesystem });
      await vi.waitFor(() => expect(filesystem.held).toHaveLength(1));
      if (request !== undefined) {
        // why: the run daemon.started began ends first, so the client's request is the only one held.
        for (const release of filesystem.held.splice(0)) release();
        for (let turn = 0; turn < 50; turn += 1) await turnOfTheEventLoop();
        void daemon
          .dispatch("cleanup.run", request, {
            manageEventSubscription: () => undefined,
            via: "socket",
            principal: "admin",
            role: "admin",
          })
          .catch(() => undefined);
        await vi.waitFor(() => expect(filesystem.held).toHaveLength(1));
      }

      // why: the stop must wait for the held run, so the read is released only once the stop has
      // either ended (a stop that did not wait has closed the state database by then) or sat
      // pending through many event-loop turns. Turns, not milliseconds: a loaded machine runs the
      // same turns, only slower.
      const stopped = daemon.stop("http-start-failed");
      let stopEnded = false;
      void stopped.then(() => {
        stopEnded = true;
      });
      for (let turn = 0; turn < 200 && !stopEnded; turn += 1) await turnOfTheEventLoop();
      for (const release of filesystem.held.splice(0)) release();
      await stopped;
      // why: a run that outlived the stop surfaces its failure a few turns after its read returns.
      for (let turn = 0; turn < 50; turn += 1) await turnOfTheEventLoop();

      const stopping = sink.records.findIndex((record) => record.message === "Daemon stopping");
      expect(stopping).toBeGreaterThanOrEqual(0);
      expect(
        sink.records
          .slice(stopping)
          .filter((record) => record.level === "warn" || record.level === "error")
          .map(({ message, module, fields }) => ({ message, module, fields })),
      ).toEqual([]);
    },
  );

  it("ends the device deletion a cleanup run has in flight before the driver is disposed", async () => {
    // why: records the order of the driver's calls, and holds the deletion the cleanup run proposes mid-call.
    class HeldDestroyDriver extends FakeDriver {
      readonly order: string[] = [];
      readonly held: (() => void)[] = [];
      override async destroy(device: Parameters<FakeDriver["destroy"]>[0]): Promise<void> {
        this.order.push("destroy started");
        await new Promise<void>((resolve) => this.held.push(resolve));
        await super.destroy(device);
        this.order.push("destroy finished");
      }
      async dispose(): Promise<void> {
        this.order.push("dispose");
      }
    }
    const clock = new FakeClock(1_000);
    const driver = new HeldDestroyDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const { daemon } = await start({ clock, drivers: [driver] });
    const agent = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "agent",
      role: "agent",
    } as const;
    const request = {
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
      requesterId: "agent-1",
    };
    const grant = (await daemon.dispatch("lease.request", request, agent)) as {
      readonly lease: { readonly id: string };
    };
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
    // why: the idle rules shut a released device down after 10 minutes and delete it after 60; each tick is the reaper's 60 s timer.
    for (let minute = 0; minute < 70 && driver.held.length === 0; minute += 1) {
      clock.advance(60_000);
      for (let turn = 0; turn < 20; turn += 1) await turnOfTheEventLoop();
    }
    expect(driver.held).toHaveLength(1);

    const stopped = daemon.stop("test-stop");
    let stopEnded = false;
    void stopped.then(() => {
      stopEnded = true;
    });
    for (let turn = 0; turn < 200 && !stopEnded; turn += 1) await turnOfTheEventLoop();
    expect(driver.order).toEqual(["destroy started"]);
    for (const release of driver.held.splice(0)) release();
    await stopped;

    expect(driver.order).toEqual(["destroy started", "destroy finished", "dispose"]);
  });
});

describe("startDaemon stop with a lease request booting its device (#1200)", () => {
  const turnOfTheEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("disposes the driver only after a lease request's boot has ended, deletes the device that failed to boot, and boots nothing for a request still queued", async () => {
    // why: records the order of the driver's boot, destroy and disposal, and holds a new device's boot until the test fails it.
    class HeldBootDriver extends FakeDriver {
      readonly order: string[] = [];
      readonly held: ((error: Error) => void)[] = [];
      override async makeReady(
        device: Parameters<FakeDriver["makeReady"]>[0],
        options: Parameters<FakeDriver["makeReady"]>[1],
      ): ReturnType<FakeDriver["makeReady"]> {
        if (options.purpose !== "prepare") return super.makeReady(device, options);
        this.order.push("boot started");
        return new Promise((_resolve, reject) =>
          this.held.push((error) => {
            this.order.push("boot failed");
            reject(error);
          }),
        );
      }
      override async destroy(device: Parameters<FakeDriver["destroy"]>[0]): Promise<void> {
        this.order.push("destroy");
        await super.destroy(device);
      }
      async dispose(): Promise<void> {
        this.order.push("dispose");
      }
    }
    const clock = new FakeClock(1_000);
    const driver = new HeldBootDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    // why: one running device, so the second requester queues behind the first one's boot and would boot its own device once that boot fails.
    const { daemon, directory } = await start({
      clock,
      configOverrides: { capacity: { config: { maxRunning: 1 }, strategy: "fixed" } },
      drivers: [driver],
    });
    const requestAs = (requesterId: string) =>
      daemon
        .dispatch(
          "lease.request",
          { model: "iPhone 16", osVersion: "26.5", platform: "ios", requesterId },
          {
            manageEventSubscription: () => undefined,
            via: "socket",
            principal: "agent",
            role: "agent",
          },
        )
        .then(
          () => "granted",
          () => "failed",
        );
    const settled = requestAs("agent-1");
    for (let turn = 0; turn < 200 && driver.held.length === 0; turn += 1) {
      await turnOfTheEventLoop();
    }
    void requestAs("agent-2");
    for (let turn = 0; turn < 20; turn += 1) await turnOfTheEventLoop();
    expect(driver.order).toEqual(["boot started"]);

    const stopped = daemon.stop("test-stop");
    let stopEnded = false;
    void stopped.then(() => {
      stopEnded = true;
    });
    for (let turn = 0; turn < 200 && !stopEnded; turn += 1) await turnOfTheEventLoop();
    expect(driver.order).toEqual(["boot started"]);
    for (const fail of driver.held.splice(0))
      fail(new Error("Timed out waiting for device to boot"));
    await stopped;
    expect(await settled).toBe("failed");
    expect(driver.order).toEqual(["boot started", "boot failed", "destroy", "dispose"]);

    const state = await openStateDatabase({
      dataDirectory: directory,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      oldFiles: [],
      owners: [registryOwner, fakeDeviceDataTable],
      sqlite: new NodeSqliteOpener(),
      upgradeStep: "unused",
    });
    const registry = await loadTestRegistry({
      clock,
      eventBus: new EventBus(clock),
      idGenerator: { generate: () => "1" },
      state,
    });
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["deleted"]);
    state.close();
  });
});

describe("startDaemon stop with a health recovery in flight (#1000)", () => {
  const turnOfTheEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
  const turns = async (count: number) => {
    for (let turn = 0; turn < count; turn += 1) await turnOfTheEventLoop();
  };
  const recovered = ["recover started", "recover finished", "dispose"];

  it.each([
    { name: "started before the stop", startsDuringStop: false, accepted: [recovered] },
    // why: a stop may either wait for this recovery or keep it from starting; it may not leave it running.
    {
      name: "due while the stop waits for a cleanup run",
      startsDuringStop: true,
      accepted: [recovered, ["dispose"]],
    },
  ])(
    "leaves no recovery reboot $name running once the drivers are disposed",
    async ({ startsDuringStop, accepted }) => {
      // why: records the order of the driver's recovery reboot and disposal, and holds the reboot mid-call.
      class HeldRecoveryDriver extends FakeDriver {
        readonly order: string[] = [];
        readonly held: (() => void)[] = [];
        override async makeReady(
          device: Parameters<FakeDriver["makeReady"]>[0],
          options: Parameters<FakeDriver["makeReady"]>[1],
        ): ReturnType<FakeDriver["makeReady"]> {
          if (options.purpose !== "recover") return super.makeReady(device, options);
          this.order.push("recover started");
          await new Promise<void>((resolve) => this.held.push(resolve));
          const ready = await super.makeReady(device, options);
          this.order.push("recover finished");
          return ready;
        }
        async dispose(): Promise<void> {
          this.order.push("dispose");
        }
      }
      // why: holds a cleanup run on its disk read once asked to, so the stop waits on it.
      class HeldDiskFree extends MemoryFilesystem {
        holding = false;
        readonly held: (() => void)[] = [];
        override async diskFree(path: string): Promise<number> {
          if (this.holding) await new Promise<void>((resolve) => this.held.push(resolve));
          return super.diskFree(path);
        }
      }
      const clock = new FakeClock(1_000);
      const driver = new HeldRecoveryDriver({
        availableOsVersions: ["26.5"],
        clock,
        platform: "ios",
      });
      const filesystem = new HeldDiskFree();
      const { daemon } = await start({ clock, drivers: [driver], filesystem });
      const agent = {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent",
        role: "agent",
      } as const;
      await daemon.dispatch(
        "lease.request",
        { model: "iPhone 16", osVersion: "26.5", platform: "ios", requesterId: "agent-1" },
        agent,
      );
      // why: the leased simulator dies outside simlock; the monitor recovers it on its second stopped reading, one 30 s tick apart.
      const { devices } = await driver.listManaged();
      expect(devices).toHaveLength(1);
      driver.setManagedReality({
        devices: devices.map((device) => ({ ...device, runState: "stopped" as const })),
        processes: [],
      });
      clock.advance(30_000);
      await turns(20);

      if (startsDuringStop) {
        filesystem.holding = true;
        void daemon
          .dispatch(
            "cleanup.run",
            { dryRun: true },
            {
              manageEventSubscription: () => undefined,
              via: "socket",
              principal: "admin",
              role: "admin",
            },
          )
          .catch(() => undefined);
        await vi.waitFor(() => expect(filesystem.held).toHaveLength(1));
      } else {
        clock.advance(30_000);
        await vi.waitFor(() => expect(driver.order).toEqual(["recover started"]));
      }

      const stopped = daemon.stop("test-stop");
      let stopEnded = false;
      void stopped.then(() => {
        stopEnded = true;
      });
      if (startsDuringStop) {
        await turns(20);
        expect(stopEnded).toBe(false);
        clock.advance(30_000);
        await turns(50);
        for (const release of filesystem.held.splice(0)) release();
      }
      for (let turn = 0; turn < 200 && !stopEnded; turn += 1) await turnOfTheEventLoop();
      for (const release of driver.held.splice(0)) release();
      await stopped;
      // why: a reboot that outlived the stop records its end a few turns after it is released.
      await turns(50);

      expect(accepted).toContainEqual(driver.order);
    },
  );
});

describe("startDaemon stop with a warm target", () => {
  it("creates no further device for a target once a stop is asked for, though the creation in flight ends while the gateway stops", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-stop-target-"));
    temporaryDirectories.push(directory);
    // why: each attempt has its own driver, so the calls of a start that lost its port are not counted.
    const { started } = await startOnFreePort(async (port) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
      driver.hangMakeReady();
      const sink = new MemoryLogSink();
      const daemon = await startUnlessPortLost(
        sink,
        startDaemon({
          deviceDataTables: fakeDeviceDataTables,
          clock,
          configOverrides: {
            capacity: { config: { maxRunning: 8 }, strategy: "fixed" },
            http: { enabled: true, host: "127.0.0.1", port },
            warmPool: {
              maxConcurrentBoots: 1,
              targets: [{ count: 2, model: "iPhone 16", osVersion: "26.5", platform: "ios" }],
            },
          },
          dataDirectory: directory,
          drivers: [driver],
          filesystem: new MemoryFilesystem(),
          logger: new JsonLinesLogger({ clock, level: "debug", sink }),
          version: "1.2.3",
        }),
      );
      return { daemon, driver };
    });
    const { daemon, driver } = started;
    runningDaemons.push(daemon);
    await expect
      .poll(() => driver.calls.filter((call) => call.operation === "makeReady").length)
      .toBe(1);

    // why: The creation ends while the HTTP gateway is still being stopped: a pool not closed by then
    // would start the second one, and the drain would wait for its whole boot.
    const stopping = daemon.stop("test-stop-target");
    driver.releaseMakeReady();
    await stopping;

    expect(driver.calls.filter((call) => call.operation === "provision")).toHaveLength(1);
  });
});

describe("startDaemon HTTP gateway stop-during-start race (review finding S5)", () => {
  it("never lets the HTTP gateway outlive full teardown when daemon.stop lands while the gateway is still mid-bind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-race-"));
    temporaryDirectories.push(directory);
    await startOnFreePort(async (port) => {
      const clock = new FakeClock(1_000);
      const sink = new MemoryLogSink();
      const logger = new JsonLinesLogger({ clock, level: "debug", sink });
      const filesystem = new MemoryFilesystem();
      const socketPath = join(directory, "daemon.sock");

      const restoreListen = delayTcpListen(200);
      try {
        const startPromise = startDaemon({
          clock,
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem,
          logger,
          socketPath,
          version: "1.2.3",
        } as StartDaemonOptions);
        void startPromise.then((daemon) => runningDaemons.push(daemon)).catch(() => undefined);

        const client = await connectRetrying(socketPath);
        const secret = (await readFileRetrying(filesystem, join(directory, "admin.token"))).trim();
        await client.request("hello", {
          clientVersion: "test",
          credential: secret,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        });
        const stopReply = await client.request("daemon.stop", {});
        expect(stopReply.ok).toBe(true);
        client.socket.end();

        await new Promise((resolve) => setTimeout(resolve, 400));
        const lostPort = sink.records.find(
          (record) => record.message === "HTTP frontend failed to start",
        );
        if (lostPort !== undefined) {
          throw Object.assign(new Error(String(lostPort.fields?.message)), { code: "EADDRINUSE" });
        }

        const stoppingIndex = sink.records.findIndex(
          (record) => record.message === "Daemon stopping",
        );
        expect(stoppingIndex).toBeGreaterThanOrEqual(0);
        const gatewayStoppedIndex = sink.records.findIndex(
          (record) => record.message === "HTTP gateway stopped",
        );
        const gatewayListeningIndex = sink.records.findIndex(
          (record) => record.message === "HTTP gateway listening",
        );
        expect(gatewayListeningIndex).toBeGreaterThanOrEqual(0);
        expect(gatewayListeningIndex).toBeLessThan(stoppingIndex);
        expect(gatewayStoppedIndex).toBeGreaterThanOrEqual(0);
        expect(gatewayStoppedIndex).toBeLessThan(stoppingIndex);

        await expect(
          fetch(`http://127.0.0.1:${port}/v1/status`, {
            headers: { authorization: "Bearer irrelevant" },
            signal: AbortSignal.timeout(200),
          }),
        ).rejects.toThrow();
      } finally {
        restoreListen();
      }
    });
  });
});

describe("startDaemon socket race with HTTP enabled", () => {
  it("rejects rather than hanging when the socket is already claimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-socket-race-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const options = (port: number): StartDaemonOptions =>
      ({
        clock: new FakeClock(1_000),
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock: new FakeClock(1_000),
            platform: "ios",
          }),
        ],
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        version: "1.2.3",
      }) as StartDaemonOptions;

    const { started: first } = await startOnFreePort((port) => startDaemon(options(port)));
    try {
      const second = startDaemon(options(await freeLoopbackPort()));
      const outcome = await Promise.race([
        second.then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000)),
      ]);
      expect(outcome).toMatchObject({ name: "DaemonAlreadyRunningError" });
    } finally {
      await first.stop("test-cleanup").catch(() => undefined);
    }
  });
});

describe("startDaemon gateway uplink when the socket claim fails", () => {
  // why: #395: the uplink is dialled from `onSocketClaimed`, so a daemon that loses the claim never
  // dials its gateway -- it would otherwise join as a worker it is about to stop being.
  it("never dials the gateway when the worker's socket is already claimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-uplink-claim-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const dials: string[] = [];
    const gateway = createHttpServer();
    gateway.on("upgrade", (request, socket) => {
      dials.push(request.url ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const { port } = gateway.address() as { readonly port: number };
    const options = (gatewayUrl?: string): StartDaemonOptions =>
      ({
        clock: new FakeClock(1_000),
        ...(gatewayUrl === undefined
          ? {}
          : { configOverrides: { gateway: { token: "join-token-395", url: gatewayUrl } } }),
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock: new FakeClock(1_000),
            platform: "ios",
          }),
        ],
        deviceDataTables: fakeDeviceDataTables,
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        version: "1.2.3",
      }) as StartDaemonOptions;

    const first = await startDaemon(options());
    try {
      const outcome = await startDaemon(options(`ws://127.0.0.1:${port}`)).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect({ dials, outcome }).toEqual({ dials: [], outcome: "rejected" });
    } finally {
      await first.stop("test-cleanup").catch(() => undefined);
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });
});

describe("startDaemon HTTP gateway bind failure", () => {
  it("rejects startDaemon() when the configured HTTP port is already in use, without emitting a started record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-bind-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", sink });
    const filesystem = new MemoryFilesystem();
    const { port, started: occupier } = await occupyFreePort();
    try {
      await expect(
        startDaemon({
          clock,
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem,
          logger,
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow(/EADDRINUSE|address already in use/i);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }

    const startedIndex = sink.records.findIndex((record) => record.message === "Daemon started");
    const stoppingIndex = sink.records.findIndex((record) => record.message === "Daemon stopping");
    expect(stoppingIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBe(-1);
  });

  // why: the bind is held until convergence has had every chance to finish, then fails, so a start that does not wait for the listener (either role's convergence) would already have logged "Daemon started".
  it.each(["worker", "gateway"] as const)(
    "fails a %s start whose HTTP listener cannot bind before it reports running, stopping with http-start-failed",
    async (role) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-http-late-bind-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      const sink = new MemoryLogSink();
      const logger = new JsonLinesLogger({ clock, level: "debug", sink });
      const { port, started: occupier } = await occupyFreePort();
      const hold = holdTcpListen();
      try {
        const settled = startDaemon({
          clock,
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem: new MemoryFilesystem(),
          hostLoadProbe: null,
          logger,
          role,
          version: "1.2.3",
        } as StartDaemonOptions).then(
          () => undefined,
          (error: unknown) => error,
        );
        await hold.bindRequested;
        // why: yields whole event-loop turns, not wall time: convergence is in-memory, so a start that does not wait for the bind logs "Daemon started" within them.
        for (
          let turn = 0;
          turn < 200 && !sink.records.some((record) => record.message === "Daemon started");
          turn += 1
        ) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        hold.release();
        expect(String(await settled)).toMatch(/EADDRINUSE|address already in use/i);
      } finally {
        hold.restore();
        await new Promise((resolve) => occupier.close(resolve));
      }

      const messages = sink.records.map((record) => record.message);
      expect(messages).not.toContain("Daemon started");
      const stopping = sink.records.find((record) => record.message === "Daemon stopping");
      expect(stopping?.fields?.reason).toBe("http-start-failed");
    },
  );
});

// why: a test that needs a port taken picks one, and another process can take it before the occupier does.
function occupyFreePort() {
  return startOnFreePort(
    (port) =>
      new Promise<Server>((resolve, reject) => {
        const occupier = createServer();
        occupier.once("error", reject);
        occupier.listen(port, "127.0.0.1", () => {
          occupier.off("error", reject);
          resolve(occupier);
        });
      }),
  );
}

/** why: Delays every TCP `listen()` call (a numeric or options-object port, as HTTP servers use) by
 * `delayMs`, real time, via `setTimeout` -- but passes a Unix-socket `listen(path, callback)`
 * call (a string first argument) straight through unpatched. Used only by the S5 race test
 * above to hold the HTTP gateway's own bind open deterministically without touching `src/http`
 * -- `@hono/node-server`'s `serve()` ultimately calls `http.Server#listen`, which is `net.Server`'s
 * own method (Node's `http` module does not override it), so patching it here reaches the
 * gateway's real bind call. Returns a restorer; always call it, even on failure. */
function delayTcpListen(delayMs: number): () => void {
  const original = Server.prototype.listen;
  type ListenFn = (...callArgs: unknown[]) => Server;
  Server.prototype.listen = function patchedListen(this: Server, ...args: unknown[]) {
    const isTcp =
      typeof args[0] === "number" ||
      (typeof args[0] === "object" && args[0] !== null && !("path" in (args[0] as object)));
    if (!isTcp) {
      return (original as ListenFn).apply(this, args);
    }
    setTimeout(() => {
      (original as ListenFn).apply(this, args);
    }, delayMs);
    return this;
  } as typeof Server.prototype.listen;
  return () => {
    Server.prototype.listen = original;
  };
}

/** why: holds every TCP `listen()` call (a numeric or options-object port, as HTTP servers use) until
 * `release()`, then runs it for real; a Unix-socket `listen(path, callback)` call (a string first
 * argument) passes straight through. `bindRequested` settles when the first TCP bind is asked for.
 * Holds the HTTP gateway's own bind open without touching `src/http`: `@hono/node-server`'s
 * `serve()` ultimately calls `http.Server#listen`, which is `net.Server`'s own method. Always
 * call `restore`, even on failure. */
function holdTcpListen(): {
  readonly bindRequested: Promise<void>;
  readonly release: () => void;
  readonly restore: () => void;
} {
  const original = Server.prototype.listen;
  type ListenFn = (...callArgs: unknown[]) => Server;
  const held: Array<() => void> = [];
  let released = false;
  let requested: () => void = () => undefined;
  const bindRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  Server.prototype.listen = function patchedListen(this: Server, ...args: unknown[]) {
    const isTcp =
      typeof args[0] === "number" ||
      (typeof args[0] === "object" && args[0] !== null && !("path" in (args[0] as object)));
    if (!isTcp) {
      return (original as ListenFn).apply(this, args);
    }
    const run = (): void => {
      (original as ListenFn).apply(this, args);
    };
    if (released) run();
    else held.push(run);
    requested();
    return this;
  } as typeof Server.prototype.listen;
  return {
    bindRequested,
    release: () => {
      released = true;
      for (const run of held.splice(0)) run();
    },
    restore: () => {
      Server.prototype.listen = original;
    },
  };
}

async function readFileRetrying(
  filesystem: MemoryFilesystem,
  path: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await filesystem.readFile(path);
    } catch (error: unknown) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
