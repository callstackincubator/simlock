import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import {
  FakeClock,
  FakeHostInfo,
  FakeHostLoadProbe,
  type HostLoadCounters,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import {
  STANDALONE_OFF,
  connectRetrying,
  runningDaemons,
  startGateway,
  stopDaemons,
  temporaryDirectories,
} from "./test-main.js";
import { freeLoopbackPort } from "./test-relay-support.js";

afterEach(stopDaemons);

const COUNTERS: HostLoadCounters = {
  cpu: { busyTime: 100, cores: 4, limited: false, totalTime: 1_000 },
  disk: { freeBytes: 120, totalBytes: 500 },
  memory: {
    availableBytes: 4_000,
    limited: false,
    pressure: "normal",
    swapUsedBytes: 100,
    totalBytes: 16_000,
  },
};

async function startOnClock(overrides: Partial<StartDaemonOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-"));
  temporaryDirectories.push(directory);
  const clock = new FakeClock(1_000);
  const daemon = await startDaemon({
    configOverrides: STANDALONE_OFF,
    deviceDataTables: fakeDeviceDataTables,
    clock,
    dataDirectory: directory,
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    filesystem: new MemoryFilesystem(),
    hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    version: "1.2.3",
    ...overrides,
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return { clock, daemon, directory };
}

const hostLoadAdmin = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
} as const;

const hostLoadRoles = [
  { role: "worker", start: startOnClock },
  { role: "gateway", start: startGateway },
] as const;

describe("startDaemon host load", () => {
  async function workerStatus(daemon: DaemonServer): Promise<Record<string, unknown>> {
    return (await daemon.dispatch(
      "status.get",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent",
        role: "agent",
      },
    )) as Record<string, unknown>;
  }

  it("answers status.get with load from the probe, on the starting answer and the running one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-slow-"));
    temporaryDirectories.push(directory);
    const clock = new FakeClock(1_000);
    const socketPath = join(directory, "daemon.sock");
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
      filesystem: new MemoryFilesystem(),
      hostLoadProbe: new FakeHostLoadProbe(COUNTERS),
      socketPath,
      version: "1.2.3",
    } as StartDaemonOptions).then((daemon) => {
      runningDaemons.push(daemon);
      return daemon;
    });
    const client = await connectRetrying(socketPath);
    try {
      await client.request("hello", {
        clientVersion: "test",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      const statusLoad = async () =>
        ((await client.request("status.get", {})).payload as { load?: unknown }).load;

      await expect
        .poll(statusLoad)
        .toEqual({ ageMs: 0, disk: COUNTERS.disk, memory: COUNTERS.memory });
      expect((await client.request("status.get", {})).payload).toMatchObject({
        daemon: { health: "starting" },
      });

      clock.advance(30_000);
      await startPromise;

      expect((await client.request("status.get", {})).payload).toMatchObject({
        daemon: { health: "running" },
      });
      expect(await statusLoad()).toMatchObject({
        disk: COUNTERS.disk,
        memory: COUNTERS.memory,
      });
    } finally {
      client.socket.end();
    }
  });

  it("answers status.get without load before the first read finishes, without waiting for it", async () => {
    const probe = new FakeHostLoadProbe();
    const { daemon } = await startOnClock({ hostLoadProbe: probe });

    expect(probe.reads).toBe(1);
    expect(await workerStatus(daemon)).not.toHaveProperty("load");

    probe.answer(COUNTERS);
    await expect
      .poll(async () => (await workerStatus(daemon)).load)
      .toMatchObject({
        memory: COUNTERS.memory,
      });
  });

  it("dials its gateway only after the first host load reading, so the gateway's first status.get carries load", async () => {
    const dials: number[] = [];
    const listener = createServer((socket) => {
      dials.push(Date.now());
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const { port } = listener.address() as { readonly port: number };
    try {
      const probe = new FakeHostLoadProbe();
      await startOnClock({
        configOverrides: { gateway: { token: "join-token-load", url: `ws://127.0.0.1:${port}` } },
        hostLoadProbe: probe,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dials).toEqual([]);

      probe.answer(COUNTERS);

      await expect.poll(() => dials.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("fits the load it answers with to the status.get bounds: an age over a day is capped at one day", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const { clock, daemon } = await startOnClock({ hostLoadProbe: probe });
    await expect.poll(async () => (await workerStatus(daemon)).load).toBeDefined();

    // why: a stepped-over clock leaves the last reading older than the schema's one-day bound.
    clock.advance(3 * 86_400_000);

    const load = (await workerStatus(daemon)).load as { ageMs: number } | undefined;
    expect(load?.ageMs).toBe(86_400_000);
  });

  it("with hostLoadProbe: null answers the same as with a probe, apart from load and the memory pressure step", async () => {
    const withProbe = await startOnClock({ hostLoadProbe: new FakeHostLoadProbe(COUNTERS) });
    const without = await startOnClock({ hostLoadProbe: null });

    await expect.poll(async () => (await workerStatus(withProbe.daemon)).load).toBeDefined();
    const { load: _load, ...probed } = await workerStatus(withProbe.daemon);
    const { memoryPressure: _step, ...capacity } = probed.capacity as Record<string, unknown>;

    expect({ ...probed, capacity }).toEqual(await workerStatus(without.daemon));
  });

  it("starts the sampler only after the daemon holds its socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-socket-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "daemon.sock");
    const socketAtRead: boolean[] = [];
    class WatchingProbe extends FakeHostLoadProbe {
      override read(): Promise<HostLoadCounters> {
        socketAtRead.push(existsSync(socketPath));
        return super.read();
      }
    }

    await startOnClock({
      dataDirectory: directory,
      hostLoadProbe: new WatchingProbe(COUNTERS),
      socketPath,
    });

    expect(socketAtRead).toEqual([true]);
  });

  it("leaves no host load timer pending when start fails after the sampler started", async () => {
    class SecretRefusingFilesystem extends MemoryFilesystem {
      override async writeFileAtomic(
        ...arguments_: Parameters<MemoryFilesystem["writeFileAtomic"]>
      ): Promise<void> {
        if (arguments_[0].endsWith("admin.token")) throw new Error("disk is read-only");
        return super.writeFileAtomic(...arguments_);
      }
    }
    const failedStart = async (hostLoadProbe: FakeHostLoadProbe | null) => {
      const directory = await mkdtemp(join(tmpdir(), "simlock-main-load-fail-"));
      temporaryDirectories.push(directory);
      const clock = new FakeClock(1_000);
      await expect(
        startDaemon({
          clock,
          configOverrides: STANDALONE_OFF,
          dataDirectory: directory,
          drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
          deviceDataTables: fakeDeviceDataTables,
          filesystem: new SecretRefusingFilesystem(),
          hostLoadProbe,
          socketPath: join(directory, "daemon.sock"),
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow("disk is read-only");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return clock.pendingTimerCount;
    };
    const probe = new FakeHostLoadProbe(COUNTERS);

    const withProbe = await failedStart(probe);
    const without = await failedStart(null);

    expect(probe.reads).toBe(1);
    expect(withProbe).toBe(without);
  });
});

describe("startDaemon in gateway mode host load", () => {
  const operator = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "test-operator",
    role: "admin",
  } as const;

  const statusOf = async (daemon: DaemonServer) =>
    (await daemon.dispatch("status.get", {}, operator)) as Record<string, unknown>;

  it("a gateway started with a probe answers status.get with the gateway machine's load from it", async () => {
    const probe = new FakeHostLoadProbe(COUNTERS);
    const { daemon } = await startGateway({ hostLoadProbe: probe });

    await expect
      .poll(async () => (await statusOf(daemon)).load)
      .toEqual({ ageMs: 0, disk: COUNTERS.disk, memory: COUNTERS.memory });
    expect(probe.reads).toBe(1);
  });

  it("a gateway started with no hostLoadProbe builds the production probe, the same factory a worker uses", async () => {
    const { daemon } = await startGateway({});

    await expect
      .poll(
        async () => ((await statusOf(daemon)).load as { memory?: { totalBytes: number } })?.memory,
      )
      .toMatchObject({ totalBytes: expect.any(Number) });
  });

  it("a gateway that lost the start race leaves no host load timer pending", async () => {
    const first = await startGateway({ hostLoadProbe: null });
    const lost = async (hostLoadProbe: FakeHostLoadProbe | null) => {
      const clock = new FakeClock(1_000);
      await expect(
        startDaemon({
          clock,
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
          },
          role: "gateway",
          dataDirectory: first.directory,
          drivers: [],
          deviceDataTables: fakeDeviceDataTables,
          filesystem: new MemoryFilesystem(),
          hostLoadProbe,
          version: "1.2.3",
        } as StartDaemonOptions),
      ).rejects.toThrow();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return clock.pendingTimerCount;
    };
    const losingProbe = new FakeHostLoadProbe(COUNTERS);

    const withLoser = await lost(losingProbe);
    const withoutLoser = await lost(null);

    expect(losingProbe.reads).toBe(0);
    expect(withLoser).toBe(withoutLoser);
  });
});

describe("startDaemon host load by role", () => {
  const statusOf = async (daemon: DaemonServer) =>
    (await daemon.dispatch("status.get", {}, hostLoadAdmin)) as Record<string, unknown>;

  it.each(hostLoadRoles)(
    "a $role started with hostLoadProbe: null answers status.get without load, and arms no host load timer",
    async ({ start }) => {
      const withProbe = await start({ hostLoadProbe: new FakeHostLoadProbe(COUNTERS) });
      const without = await start({ hostLoadProbe: null });

      await expect.poll(async () => (await statusOf(withProbe.daemon)).load).toBeDefined();

      expect(await statusOf(without.daemon)).not.toHaveProperty("load");
      expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);
    },
  );

  it.each(hostLoadRoles)(
    "a $role leaves no host load timer pending after a stop",
    async ({ start }) => {
      const withProbe = await start({ hostLoadProbe: new FakeHostLoadProbe(COUNTERS) });
      const without = await start({ hostLoadProbe: null });
      expect(withProbe.clock.pendingTimerCount).toBeGreaterThan(without.clock.pendingTimerCount);

      await withProbe.daemon.stop("test");
      await without.daemon.stop("test");

      expect(withProbe.clock.pendingTimerCount).toBe(without.clock.pendingTimerCount);
    },
  );
});

function memoryReading(
  pressure: "normal" | "warn" | "critical" | undefined,
  availablePercent: number,
): HostLoadCounters {
  const { pressure: _pressure, ...memory } = COUNTERS.memory!;
  return {
    ...COUNTERS,
    memory: {
      ...memory,
      availableBytes: Math.round(160 * availablePercent),
      totalBytes: 16_000,
      ...(pressure === undefined ? {} : { pressure }),
    },
  };
}

describe("startDaemon memory pressure", () => {
  const statusOf = async (daemon: DaemonServer) =>
    (await daemon.dispatch("status.get", {}, hostLoadAdmin)) as {
      capacity?: { memoryPressure?: unknown };
    };

  it("reports in status.get the memory pressure step the worker's reading meets", async () => {
    const level = (availablePercent: number, name: "warn" | "critical") => ({
      availablePercent,
      level: name,
      trigger: "level",
    });
    const floor = (availablePercent: number, floorPercent: number) => ({
      availablePercent,
      floorPercent,
      trigger: "floor",
    });
    const cases: readonly {
      readonly reading: HostLoadCounters;
      readonly expected: unknown;
      readonly overrides?: NonNullable<StartDaemonOptions["configOverrides"]>["memoryPressure"];
    }[] = [
      { reading: memoryReading("normal", 34), expected: { step: "none" } },
      {
        reading: memoryReading("warn", 34),
        expected: { cause: level(34, "warn"), since: 1_000, step: "warming-paused" },
      },
      {
        reading: memoryReading("critical", 34),
        expected: { cause: level(34, "critical"), since: 1_000, step: "new-devices-paused" },
      },
      {
        reading: memoryReading("warn", 8),
        expected: { cause: floor(8, 10), since: 1_000, step: "new-devices-paused" },
      },
      {
        reading: memoryReading("critical", 8),
        expected: { cause: level(8, "critical"), since: 1_000, step: "new-devices-paused" },
      },
      {
        reading: memoryReading("normal", 8),
        expected: { cause: floor(8, 10), since: 1_000, step: "new-devices-paused" },
      },
      { reading: memoryReading(undefined, 25), expected: { step: "none" } },
      {
        reading: memoryReading(undefined, 15),
        expected: { cause: floor(15, 20), since: 1_000, step: "warming-paused" },
      },
      {
        reading: memoryReading(undefined, 9.9),
        expected: { cause: floor(9, 10), since: 1_000, step: "new-devices-paused" },
      },
      {
        reading: memoryReading("critical", 5),
        overrides: {
          pauseNewDevices: { level: "off", minAvailablePercent: 0 },
          pauseWarming: { level: "off", minAvailablePercent: 0 },
        },
        expected: { step: "none" },
      },
      {
        reading: memoryReading("critical", 5),
        overrides: { enabled: false },
        expected: { step: "none" },
      },
    ];
    for (const { reading, expected, overrides } of cases) {
      const { daemon } = await startOnClock({
        configOverrides: {
          ...STANDALONE_OFF,
          ...(overrides === undefined ? {} : { memoryPressure: overrides }),
        },
        hostLoadProbe: new FakeHostLoadProbe(reading),
      });
      await expect
        .poll(async () => (await statusOf(daemon)).capacity?.memoryPressure)
        .toEqual(expected);
    }
  });
});

describe("startDaemon memory pressure hold", () => {
  const statusOf = async (daemon: DaemonServer) =>
    (await daemon.dispatch("status.get", {}, hostLoadAdmin)) as {
      capacity?: { memoryPressure?: unknown };
      load?: { ageMs: number };
    };

  it("lifts a memory pressure step only after clearAfterMs with no meeting reading", async () => {
    const level = (name: "warn" | "critical") => ({
      availablePercent: 34,
      level: name,
      trigger: "level",
    });
    const warming = (since: number) => ({
      cause: level("warn"),
      since,
      step: "warming-paused",
    });
    const calm = memoryReading("normal", 34);
    const scenarios = [
      {
        // why: calm from +15 s lifts at +75 s: 45 s after the first calm reading it still holds.
        name: "calm for 45 s still holds, for 60 s lifts",
        readings: [
          { reading: memoryReading("warn", 34), expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: { step: "none" } },
        ],
      },
      {
        name: "a meeting reading restarts the hold and keeps since and cause",
        readings: [
          { reading: memoryReading("warn", 34), expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: memoryReading("warn", 30), expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: warming(1_000) },
          { reading: calm, expected: { step: "none" } },
        ],
      },
      {
        name: "new devices paused falls to warming paused with warming's own since and cause",
        readings: [
          { reading: memoryReading("warn", 34), expected: warming(1_000) },
          {
            reading: memoryReading("critical", 34),
            expected: { cause: level("critical"), since: 16_000, step: "new-devices-paused" },
          },
          ...[0, 1, 2, 3].map(() => ({
            reading: memoryReading("warn", 34),
            expected: { cause: level("critical"), since: 16_000, step: "new-devices-paused" },
          })),
          { reading: memoryReading("warn", 34), expected: warming(1_000) },
        ],
      },
    ];
    for (const { name, readings } of scenarios) {
      const probe = new FakeHostLoadProbe();
      const { clock, daemon } = await startOnClock({ hostLoadProbe: probe });
      for (const [index, { reading, expected }] of readings.entries()) {
        if (index > 0) clock.advance(15_000);
        await expect.poll(() => probe.reads, { message: name }).toBe(index + 1);
        probe.answer(reading);
        await expect.poll(async () => (await statusOf(daemon)).load?.ageMs).toBe(0);
        expect((await statusOf(daemon)).capacity?.memoryPressure, `${name} #${index}`).toEqual(
          expected,
        );
      }
    }
  });

  it("drops the step at once when there is no usable reading: a failed read or no memory part, and with host load off no field", async () => {
    const { disk, cpu } = COUNTERS;
    const unusable = [
      new Error("sysctl failed"),
      { cpu: cpu!, disk: disk! } satisfies HostLoadCounters,
    ];
    for (const next of unusable) {
      const probe = new FakeHostLoadProbe();
      const { clock, daemon } = await startOnClock({ hostLoadProbe: probe });
      await expect.poll(() => probe.reads).toBe(1);
      probe.answer(memoryReading("critical", 5));
      await expect
        .poll(async () => (await statusOf(daemon)).capacity?.memoryPressure)
        .toMatchObject({ cause: { availablePercent: 5 }, step: "new-devices-paused" });

      clock.advance(15_000);
      await expect.poll(() => probe.reads).toBe(2);
      probe.answer(next);

      await expect
        .poll(async () => (await statusOf(daemon)).capacity?.memoryPressure)
        .toEqual({ step: "none" });
    }

    const off = await startOnClock({ hostLoadProbe: null });
    expect((await statusOf(off.daemon)).capacity).not.toHaveProperty("memoryPressure");
  });
});
