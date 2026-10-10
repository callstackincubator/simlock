import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";
import {
  HELD_LEASE,
  LEASED,
  PHYSICAL_AGENT,
  PHYSICAL_MODEL,
  PHYSICAL_OS,
  READY,
  RECLAIMING,
  callsNaming,
  observeFor,
  seedPhysicalState,
  type PhysicalSeed,
  type SeededLease,
} from "./helpers/physical-state.js";

/**
 * The core knows a device record may be physical (ADR 0022): a physical record is written into
 * `state.json`'s `physicalDevices` by hand, as the tests below do, and every path that acts on
 * simulators and emulators leaves it alone. "No driver call names it" means the fake driver's
 * call log has no call whose arguments carry the record's `driverDeviceId`.
 */

const IOS = {
  availableOsVersions: [PHYSICAL_OS],
  defaultModels: { phone: ["iPhone 16"] },
  knownModels: [PHYSICAL_MODEL, "iPhone 16"],
  modelClasses: { "iPhone 16": "phone", [PHYSICAL_MODEL]: "phone" },
} as const;

interface Row {
  readonly id: string;
  readonly driverDeviceId?: string;
  readonly state: string;
  readonly physical?: boolean;
  readonly class?: string;
  readonly mode?: string;
  readonly enrolledApps?: unknown;
  readonly lastLeaseEndedAt?: number;
  readonly spec: { readonly model: string; readonly physical?: boolean };
}

interface Finding {
  readonly kind: string;
  readonly deviceId?: string;
}

interface Capacity {
  readonly used: number;
  readonly running: number;
  readonly warm: number;
}

async function startWith(
  physical: readonly PhysicalSeed[],
  options: {
    readonly leases?: readonly SeededLease[];
    readonly config?: Record<string, unknown>;
    readonly script?: Record<string, unknown>;
  } = {},
): Promise<TestEnv> {
  const env = await withDaemon({
    agentId: PHYSICAL_AGENT,
    configOverrides: options.config ?? {},
    driverScript: { ios: { ...IOS, ...options.script } },
    mode: "auto",
  });
  await seedPhysicalState(env, physical, options.leases ?? []);
  const started = await env.startDaemon();
  expect(started.code, started.stderr).toBe(0);
  return env;
}

async function rows(env: TestEnv): Promise<Row[]> {
  const result = await env.cli(["list", "--devices"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Row[];
}

async function stateOf(env: TestEnv, id: string): Promise<string | undefined> {
  return (await rows(env)).find((row) => row.id === id)?.state;
}

async function expectState(env: TestEnv, id: string, state: string): Promise<void> {
  expect(await stateOf(env, id), `${id} is listed as ${state}`).toBe(state);
}

async function iosCapacity(env: TestEnv): Promise<Capacity> {
  const result = await env.cli(["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return (result.json as { capacity: { ios: Capacity } }).capacity.ios;
}

async function named(env: TestEnv, ...names: string[]) {
  return (await env.events()).filter((entry) => names.includes(entry.event));
}

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: Row & { readonly driverDeviceId: string };
}

let agents = 0;

async function leaseSimulator(env: TestEnv, extra: readonly string[]): Promise<Grant> {
  agents += 1;
  const result = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--agent-id",
    `sim-agent-${String(agents)}`,
    "--detach",
    ...extra,
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

describe("the core knows physical devices", () => {
  it("a daemon started, then restarted, with a ready, a leased and a reclaiming physical record keeps each in its state, the lease renews for its owner, and no driver call names any of them", async () => {
    const env = await startWith([READY, LEASED, RECLAIMING], { leases: [HELD_LEASE(600_000)] });

    for (const restarts of [0, 1]) {
      if (restarts === 1) await env.restartDaemon();
      await expectState(env, READY.id, "ready");
      await expectState(env, LEASED.id, "leased");
      await expectState(env, RECLAIMING.id, "reclaiming");
    }

    const renewed = await env.cli(["lease", "renew", "lse_pheld"]);
    expect(renewed.code, renewed.stderr).toBe(0);
    expect(
      await callsNaming(
        env,
        READY.driverDeviceId,
        LEASED.driverDeviceId,
        RECLAIMING.driverDeviceId,
      ),
    ).toEqual([]);
  });

  it("a leased physical record whose lease deadline passed before the daemon started: right after start the lease ends with lease.expired, the record is reclaiming, and no lease.released with reason device-lost and no driver call names it", async () => {
    const env = await startWith([LEASED], { leases: [HELD_LEASE(-60_000)] });
    const startedAfter = Date.now() - 60_000;

    await waitFor(async () => (await named(env, "lease.expired")).length > 0, {
      label: "the lease expires right after start",
    });
    expect((await named(env, "lease.expired")).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ leaseId: "lse_pheld" }),
    ]);
    const row = (await rows(env)).find((candidate) => candidate.id === LEASED.id);
    expect(row?.state).toBe("reclaiming");
    expect(row?.lastLeaseEndedAt).toBeGreaterThan(startedAfter);
    expect(
      (await named(env, "lease.released")).filter(
        (entry) => (entry.payload as { reason?: string }).reason === "device-lost",
      ),
    ).toEqual([]);
    expect(await callsNaming(env, LEASED.driverDeviceId)).toEqual([]);
  });

  it("with health.probeIntervalMs 200 and stableObservations 2, a leased physical record is still leased after two seconds, its lease renews, and no lease.released or device.deleted names it", async () => {
    const env = await startWith([LEASED], {
      config: { health: { probeIntervalMs: 200, stableObservations: 2 } },
      leases: [HELD_LEASE(600_000)],
    });

    await observeFor(2_000, async () => {
      expect(await stateOf(env, LEASED.id), "the leased record stays leased").toBe("leased");
    });

    const renewed = await env.cli(["lease", "renew", "lse_pheld"]);
    expect(renewed.code, renewed.stderr).toBe(0);
    const ended = await named(env, "lease.released", "device.deleted");
    expect(ended.filter((entry) => JSON.stringify(entry.payload).includes(LEASED.id))).toEqual([]);
  });

  it("doctor --fix reports no finding naming the ready or the leased physical record and leaves both in their state", async () => {
    const env = await startWith([READY, LEASED], { leases: [HELD_LEASE(600_000)] });

    const fixed = await env.cli(["doctor", "--fix"]);
    expect(fixed.code, fixed.stderr).toBe(0);

    const findings = JSON.stringify((fixed.json as { findings: Finding[] }).findings);
    for (const name of [READY.id, READY.driverDeviceId, LEASED.id, LEASED.driverDeviceId]) {
      expect(findings).not.toContain(name);
    }
    await expectState(env, READY.id, "ready");
    await expectState(env, LEASED.id, "leased");
  });

  it("doctor --fix reports stalled-transition for the reclaiming physical record and moves it to quarantined with device.quarantined; after warmPool.quarantine.retryBackoffMs has passed, no driver call names it", async () => {
    const env = await startWith([RECLAIMING], {
      config: { warmPool: { quarantine: { retryBackoffMs: 300 } } },
    });

    const fixed = await env.cli(["doctor", "--fix"]);
    expect(fixed.code, fixed.stderr).toBe(0);

    expect((fixed.json as { findings: Finding[] }).findings).toContainEqual(
      expect.objectContaining({ deviceId: RECLAIMING.id, kind: "stalled-transition" }),
    );
    await expectState(env, RECLAIMING.id, "quarantined");
    expect(await named(env, "device.quarantined")).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ deviceId: RECLAIMING.id }) }),
    );
    await observeFor(1_500, async () => {
      expect(await stateOf(env, RECLAIMING.id), "no retry moves the record").toBe("quarantined");
    });
    expect(await callsNaming(env, RECLAIMING.driverDeviceId)).toEqual([]);
  });

  it("with a scripted orphan simulator and a scripted root device whose ID is the ready physical record's driverDeviceId, doctor --purge-orphans --yes destroys the orphan, reports no orphan for that ID, and no destroy call names it", async () => {
    const env = await startWith([READY], {
      script: {
        managedReality: {
          devices: [
            { deviceId: "fake-ios-orphan", runState: "running" },
            { deviceId: READY.driverDeviceId, runState: "running" },
          ],
        },
      },
    });

    const purged = await env.cli(["doctor", "--purge-orphans", "--yes"]);
    expect(purged.code, purged.stderr).toBe(0);

    const destroyed = (await env.driverLog.calls()).filter((call) => call.operation === "destroy");
    expect(destroyed.map((call) => JSON.stringify(call.arguments))).toEqual([
      expect.stringContaining("fake-ios-orphan"),
    ]);
    expect(JSON.stringify((purged.json as { findings: Finding[] }).findings)).not.toContain(
      READY.driverDeviceId,
    );
    expect(await callsNaming(env, READY.driverDeviceId)).toEqual([]);
    await expectState(env, READY.id, "ready");
  });

  it("with idle thresholds of one second and the ready physical record's lastLeaseEndedAt an hour old, cleanup --dry-run proposes nothing for it, and cleanup leaves it ready with no shutdown call", async () => {
    const env = await startWith([READY], {
      config: { idle: { deleteAfterMs: 1_000, shutdownAfterMs: 1_000 } },
    });

    const preview = await env.cli(["cleanup", "--dry-run"]);
    expect(preview.code, preview.stderr).toBe(0);
    expect((preview.json as { target: string }[]).map((proposal) => proposal.target)).toEqual([]);
    const cleaned = await env.cli(["cleanup"]);
    expect(cleaned.code, cleaned.stderr).toBe(0);

    await expectState(env, READY.id, "ready");
    expect(await callsNaming(env, READY.driverDeviceId)).toEqual([]);
  });

  it("with warmPool.enabled false, the ready physical record is still ready after the pool's pass, with no shutdown call", async () => {
    const env = await startWith([READY], { config: { warmPool: { enabled: false } } });

    await observeFor(2_000, async () => {
      await expectState(env, READY.id, "ready");
    });
    expect(await callsNaming(env, READY.driverDeviceId)).toEqual([]);
  });

  it("a warm target of one iPhone 15 Pro on 18.4 provisions a simulator; the target's report counts that simulator, not the physical record; its device.provisioned spec carries physical false", async () => {
    const target = { count: 1, model: PHYSICAL_MODEL, osVersion: PHYSICAL_OS, platform: "ios" };
    const env = await startWith([READY], { config: { warmPool: { targets: [target] } } });

    await waitFor(async () => (await named(env, "device.provisioned")).length > 0, {
      label: "the pool provisions a simulator",
    });
    await waitFor(
      async () => {
        const status = (await env.cli(["status", "--json"])).json as {
          warmPool: { targets: { ready: number }[] };
        };
        return status.warmPool.targets[0]?.ready === 1;
      },
      { label: "the target's report counts one ready device" },
    );

    const [provisioned] = await named(env, "device.provisioned");
    expect(provisioned?.payload).toMatchObject({ spec: { physical: false } });
    const simulators = (await rows(env)).filter((row) => row.id !== READY.id);
    expect(simulators.map((row) => row.spec.model)).toEqual([PHYSICAL_MODEL]);
    expect(simulators[0]?.physical).toBe(false);
    await expectState(env, READY.id, "ready");
  });

  it("with limits.ios.maxDevices 1 and a ready physical record, a warm target of one iPhone 15 Pro on 18.4 provisions a simulator; were the physical record counted, the device limit would refuse it", async () => {
    const target = { count: 1, model: PHYSICAL_MODEL, osVersion: PHYSICAL_OS, platform: "ios" };
    const env = await startWith([READY], {
      config: {
        limits: { ios: { maxDevices: 1, maxRunning: 8 } },
        warmPool: { targets: [target] },
      },
    });

    await waitFor(async () => (await named(env, "device.provisioned")).length > 0, {
      label: "the pool provisions a simulator past the device limit a physical record would fill",
    });
    await expectState(env, READY.id, "ready");
  });

  it("with limits.ios.maxRunning 1, a ready physical record and a shut-down iPhone 15 Pro simulator on 18.4, a warm target of one iPhone 15 Pro on 18.4 boots that simulator; were the physical record counted, the running limit would refuse the boot", async () => {
    const target = { count: 1, model: PHYSICAL_MODEL, osVersion: PHYSICAL_OS, platform: "ios" };
    const env = await startWith([READY], {
      config: { limits: { ios: { maxDevices: 8, maxRunning: 1 } } },
    });
    const held = await leaseSimulator(env, ["--device", PHYSICAL_MODEL, "--os", PHYSICAL_OS]);
    expect((await env.cli(["release", held.lease.id])).code).toBe(0);
    await env.withConfig({ idle: { shutdownAfterMs: 1 } }, async () => {
      await waitFor(
        async () => {
          await env.cli(["cleanup"]);
          return (await stateOf(env, held.device.id)) === "shutdown";
        },
        { label: "the simulator is shut down" },
      );
    });

    await env.withConfig({ warmPool: { targets: [target] } }, async () => {
      await waitFor(async () => (await stateOf(env, held.device.id)) === "ready", {
        label: "the pool boots the shut-down simulator",
      });
    });
    await expectState(env, READY.id, "ready");
  });

  it("with limits.ios.maxDevices 1 and maxRunning 1 and a ready physical record, lease --platform ios --no-wait is granted a new simulator, not NO_CAPACITY; the physical record stays ready, and status' iOS used, running and warm count only the simulator", async () => {
    const env = await startWith([READY], {
      config: { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } },
    });

    const granted = await leaseSimulator(env, ["--no-wait"]);

    expect(granted.device.id).not.toBe(READY.id);
    await expectState(env, READY.id, "ready");
    expect(await iosCapacity(env)).toMatchObject({ running: 1, used: 1, warm: 0 });
  });

  it("with limits.ios.maxDevices 1, an idle ready iPhone 16 simulator and a ready physical record whose lastLeaseEndedAt is older than the simulator's, lease --platform ios --device iPhone 15 Pro evicts the simulator (a destroy call names it) and is granted a new simulator; the physical record stays ready, and no driver call names it", async () => {
    const env = await startWith([READY], {
      config: { limits: { ios: { maxDevices: 1, maxRunning: 8 } } },
      script: { reclaimResult: "ready" },
    });
    const first = await leaseSimulator(env, ["--device", "iPhone 16", "--os", PHYSICAL_OS]);
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await waitFor(async () => (await stateOf(env, first.device.id)) === "ready", {
      label: "the iPhone 16 simulator is idle and ready",
    });

    const granted = await leaseSimulator(env, ["--device", PHYSICAL_MODEL, "--os", PHYSICAL_OS]);

    expect(granted.device.id).not.toBe(READY.id);
    expect(granted.device.spec.model).toBe(PHYSICAL_MODEL);
    const destroyed = (await env.driverLog.calls()).filter((call) => call.operation === "destroy");
    expect(destroyed.map((call) => JSON.stringify(call.arguments))).toEqual([
      expect.stringContaining(first.device.driverDeviceId),
    ]);
    await expectState(env, READY.id, "ready");
    expect(await callsNaming(env, READY.driverDeviceId)).toEqual([]);
  });

  it("with a ready and a leased physical record, the capacity.changed emitted at start and after a simulator lease count only the simulator in iOS running and warm; under the resource capacity strategy its ramBudget.usedBytes and status' match the simulator's alone", async () => {
    const env = await startWith([READY, LEASED], { leases: [HELD_LEASE(600_000)] });
    const perDevice = 1024 * 1024;

    const atStart = (await named(env, "capacity.changed")).at(0)?.payload as {
      ios: { running: number; warm: number };
      ramBudget: { usedBytes: number };
    };
    expect(atStart.ios).toMatchObject({ running: 0, warm: 0 });
    expect(atStart.ramBudget.usedBytes).toBe(0);

    await leaseSimulator(env, ["--device", "iPhone 16", "--os", PHYSICAL_OS]);

    await waitFor(
      async () => {
        const latest = (await named(env, "capacity.changed")).at(-1)?.payload as {
          ios: { running: number; warm: number };
          ramBudget: { usedBytes: number };
        };
        return latest.ios.running === 1 && latest.ramBudget.usedBytes === perDevice;
      },
      { label: "the latest capacity.changed counts the simulator alone" },
    );
    const latest = (await named(env, "capacity.changed")).at(-1)?.payload as {
      ios: { warm: number };
    };
    expect(latest.ios.warm).toBe(0);
    await expectState(env, READY.id, "ready");
    await expectState(env, LEASED.id, "leased");
    const status = (await env.cli(["status", "--json"])).json as {
      capacity: { ramBudget: { usedBytes: number } };
    };
    expect(status.capacity.ramBudget.usedBytes).toBe(perDevice);
  });

  it("lease --platform ios --device iPhone 15 Pro --os 18.4 and lease --platform ios --class phone are each granted a simulator while the physical record of that model and OS is ready", async () => {
    const env = await startWith([READY]);

    const byModel = await leaseSimulator(env, ["--device", PHYSICAL_MODEL, "--os", PHYSICAL_OS]);
    const byClass = await leaseSimulator(env, ["--class", "phone"]);

    for (const granted of [byModel, byClass]) {
      expect(granted.device.id).not.toBe(READY.id);
      expect(granted.device.driverDeviceId).not.toBe(READY.driverDeviceId);
    }
    await expectState(env, READY.id, "ready");
  });

  it("with a ready and a reclaiming physical record and no physical lease, nuke --delete-devices --yes destroys a simulator as today, keeps both physical records in their states, and no shutdown or destroy call names them", async () => {
    const env = await startWith([READY, RECLAIMING]);
    const held = await leaseSimulator(env, ["--device", "iPhone 16", "--os", PHYSICAL_OS]);
    expect((await env.cli(["release", held.lease.id])).code).toBe(0);

    const nuke = await env.cli(["nuke", "--delete-devices", "--yes"]);
    expect(nuke.code, nuke.stderr).toBe(0);

    const destroyed = (await env.driverLog.calls()).filter((call) => call.operation === "destroy");
    expect(destroyed.map((call) => JSON.stringify(call.arguments))).toEqual([
      expect.stringContaining(held.device.driverDeviceId),
    ]);
    await expectState(env, READY.id, "ready");
    await expectState(env, RECLAIMING.id, "reclaiming");
    expect(await callsNaming(env, READY.driverDeviceId, RECLAIMING.driverDeviceId)).toEqual([]);
  });

  it("a physical lease whose deadline passes while the daemon runs ends with lease.expired; its record is reclaiming with lastLeaseEndedAt set, and no driver call names it", async () => {
    const env = await startWith([LEASED], { leases: [HELD_LEASE(8_000)] });
    const startedAt = Date.now();
    expect(
      (await env.cli(["list", "--leases"])).json,
      "the lease is still held when the daemon is up",
    ).toHaveLength(1);

    await waitFor(async () => (await named(env, "lease.expired")).length > 0, {
      label: "the lease expires",
      timeout: 30_000,
    });

    const row = (await rows(env)).find((candidate) => candidate.id === LEASED.id);
    expect(row?.state).toBe("reclaiming");
    expect(row?.lastLeaseEndedAt).toBeGreaterThanOrEqual(startedAt);
    expect(await callsNaming(env, LEASED.driverDeviceId)).toEqual([]);
  });

  it("status --json and list --devices show a physical record with physical true, class phone and no mode, and a simulator with physical false, its mode and no class", async () => {
    const env = await startWith([READY]);
    const sim = await leaseSimulator(env, ["--device", "iPhone 16", "--os", PHYSICAL_OS]);

    const status = (await env.cli(["status", "--json"])).json as { devices: Row[] };
    const listed = await rows(env);

    for (const devices of [status.devices, listed]) {
      const physical = devices.find((row) => row.id === READY.id);
      expect(physical?.physical).toBe(true);
      expect(physical?.class).toBe("phone");
      expect(physical?.mode).toBeUndefined();
      const simulator = devices.find((row) => row.id === sim.device.id);
      expect(simulator?.physical).toBe(false);
      expect(simulator?.mode).toBe("full");
      expect(simulator?.class).toBeUndefined();
    }
  });
});

interface Fleet {
  readonly gateway: TestEnv;
  readonly worker: TestEnv;
  readonly port: number;
}

async function fleetWithPhysicalWorker(physical: readonly PhysicalSeed[]): Promise<Fleet> {
  const port = await freeLoopbackPort();
  const gateway = await withDaemon({
    configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
    driver: "none",
  });
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const worker = await withDaemon({
    agentId: PHYSICAL_AGENT,
    configOverrides: {
      gateway: { label: "worker-p", token: secret, url: `ws://127.0.0.1:${port}` },
    },
    driverScript: { ios: IOS },
    mode: "auto",
  });
  await seedPhysicalState(worker, physical);
  const started = await worker.startDaemon();
  expect(started.code, started.stderr).toBe(0);
  await waitFor(
    async () => {
      const status = (await gateway.cli(["status", "--json"])).json as { devices?: Row[] };
      return (status.devices ?? []).some((row) => row.id === physical[0]?.id);
    },
    { label: "the gateway lists the worker's physical record", timeout: 30_000 },
  );
  return { gateway, port, worker };
}

describe("a gateway with a worker that holds a physical record", () => {
  it("a gateway lists a worker's physical record with physical, class and workerId, and a gateway lease --platform ios --device iPhone 15 Pro --os 18.4 is granted a simulator on that worker", async () => {
    const { gateway } = await fleetWithPhysicalWorker([READY]);

    const status = (await gateway.cli(["status", "--json"])).json as {
      devices: (Row & { workerId?: string })[];
    };
    const listed = status.devices.find((row) => row.id === READY.id);
    expect(listed).toMatchObject({ class: "phone", physical: true });
    expect(listed?.workerId).toEqual(expect.any(String));

    const granted = await gateway.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      PHYSICAL_MODEL,
      "--os",
      PHYSICAL_OS,
      "--agent-id",
      "gateway-agent",
      "--detach",
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    const grant = granted.json as { device: Row & { workerId?: string } };
    expect(grant.device.physical).toBe(false);
    expect(grant.device.id).not.toBe(READY.id);
  });

  it("with a physical record seeded with two enrolled apps, the status --json and list --devices answers and a gateway's GET /v1/workers carry no enrolledApps on it", async () => {
    const seeded = { ...READY, enrolledApps: ["com.example.one", "com.example.two"] };
    const { gateway, port, worker } = await fleetWithPhysicalWorker([seeded]);

    const status = (await worker.cli(["status", "--json"])).json as { devices: Row[] };
    const listed = await rows(worker);
    for (const devices of [status.devices, listed]) {
      const record = devices.find((row) => row.id === READY.id);
      expect(record, "the physical record is listed").toBeDefined();
      expect(record).not.toHaveProperty("enrolledApps");
    }

    const operator = await gateway.cli(["token", "create", "--role", "operator"]);
    const response = await fetch(`http://127.0.0.1:${port}/v1/workers`, {
      headers: { authorization: `Bearer ${(operator.json as { secret: string }).secret}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workers: { devices?: Row[] }[] };
    const record = body.workers
      .flatMap((view) => view.devices ?? [])
      .find((row) => row.id === READY.id);
    expect(record, "the gateway's worker view lists the physical record").toBeDefined();
    expect(record).not.toHaveProperty("enrolledApps");
  });
});
