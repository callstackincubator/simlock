import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  baselinesOwner,
  BootTimeoutError,
  type Config,
  DeviceOperationClaims,
  DriverCatalog,
  loadConfig,
  ManagedDeviceLifecycle,
  Registry,
  registryOwner,
  type VirtualDevice,
  type VirtualSpec,
  warmPoolOwner,
} from "../core/index.js";
import { openMemoryState, testComponentWiring } from "../core/testing.js";
import { IosSimctlDriver, iosDeviceDataTable, iosSourceDataOwner } from "../drivers/ios/index.js";
import { plantReadySeed } from "../drivers/ios/testing.js";
import { createTestEngine } from "../leasing/testing.js";
import {
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";

const deviceRoot = "/Devices";
const sourcesRoot = `${deviceRoot}/sources`;
const udid = "00000000-0000-0000-0000-000000000001";
const seedUdid = "00000000-0000-0000-0000-0000000000aa";
const deviceTypeId = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const runtimeId = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const request = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;
const requester = { ownerId: "agent-1", requesterId: "agent-1" } as const;
const listFixture = readFileSync(
  new URL("../drivers/ios/fixtures/simctl-list.json", import.meta.url),
  "utf8",
);
const gibibyte = 1024 ** 3;
const spec: VirtualSpec = { ...request, physical: false };
const driverData = {
  deviceTypeId,
  name: "simlock-device-1",
  runtimeId,
  udid,
} as const;

function simctl(...args: readonly string[]) {
  return { args: ["simctl", "--set", deviceRoot, ...args], command: "xcrun" };
}

function seedSimctl(...args: readonly string[]) {
  return { args: ["simctl", "--set", sourcesRoot, ...args], command: "xcrun" };
}

const listed: ScriptedProcessExpectation = {
  match: simctl("list", "-j", "devicetypes", "runtimes"),
  result: { code: 0, stderr: "", stdout: listFixture },
};
const cloned: ScriptedProcessExpectation = {
  match: seedSimctl("clone", seedUdid, "simlock-device-1", deviceRoot),
  result: { code: 0, stderr: "", stdout: `${udid}\n` },
};

const startedAt = 1_000;
const seedCreated: ScriptedProcessExpectation = {
  match: seedSimctl("create", "simlock-seed-device-1", deviceTypeId, runtimeId),
  result: { code: 0, stderr: "", stdout: `${seedUdid}\n` },
};

/** why: a clock-driven finish, so the child stays running across the deadline the test straddles. */
function finishesAfter(clock: FakeClock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(milliseconds, resolve);
  });
}

/** why: every real part of a worker over a scripted `xcrun`: only the machine is faked. */
async function createHarness(
  script: (clock: FakeClock) => readonly ScriptedProcessExpectation[],
  options: { readonly seeded?: boolean } = {},
) {
  const clock = new FakeClock(startedAt);
  const eventBus = new EventBus(clock);
  const runner = new ScriptedProcessRunner(script(clock));
  const state = await openMemoryState([
    registryOwner,
    warmPoolOwner,
    baselinesOwner,
    iosDeviceDataTable,
    iosSourceDataOwner,
  ]);
  if (options.seeded !== false) {
    plantReadySeed(state.database, { deviceTypeId, runtimeId, udid: seedUdid });
  }
  let nextId = 1;
  const idGenerator = { generate: () => String(nextId++) };
  const registry = await Registry.load({
    clock,
    deviceData: new Map([["ios", iosDeviceDataTable]]),
    eventBus,
    idGenerator,
    state,
  });
  const filesystem = new MemoryFilesystem();
  const driver = await IosSimctlDriver.create({
    clock,
    database: state.database,
    driverConfig: { deviceRoot },
    filesystem,
    idGenerator: { generate: () => "device-1" },
    instanceId: "instance-1",
    processRunner: runner,
    simlockHome: "/home/.simlock",
  });
  await filesystem.mkdirp(`${deviceRoot}/${udid}/data`);
  const systemStats = new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte });
  const config: Config = await loadConfig({ filesystem: new MemoryFilesystem(), systemStats });
  const drivers = [driver];
  const wiring = testComponentWiring({ clock, drivers, eventBus, registry });
  const engine = createTestEngine({
    ...wiring,
    clock,
    config,
    drivers,
    eventBus,
    idGenerator,
    registry,
    state,
    systemStats,
  });
  const claims = new DeviceOperationClaims();
  const lifecycle = new ManagedDeviceLifecycle(
    new DriverCatalog(drivers),
    registry,
    wiring.decisions,
    claims,
    clock,
  );
  return { claims, clock, engine, eventBus, lifecycle, registry, runner };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function commands(harness: Harness): readonly (string | undefined)[] {
  return harness.runner.calls.map((call) => call.args[3]);
}

/** why: the whole argv, because a command for the wrong device is swallowed by best-effort cleanup and shares its verb with the right one. */
function expectCalls(harness: Harness, ...expected: readonly ReturnType<typeof simctl>[]): void {
  expect(harness.runner.calls.map(({ args, command }) => ({ args, command }))).toEqual(expected);
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
}

/** why: a request crosses several awaits on the way to a command; a bounded wait names one that never comes. */
async function untilCommand(harness: Harness, command: string, count = 1): Promise<void> {
  const seen = (): number => commands(harness).filter((name) => name === command).length;
  for (let attempt = 0; attempt < 50 && seen() < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(commands(harness).filter((name) => name === command)).toHaveLength(count);
}

async function registeredDevice(harness: Harness): Promise<VirtualDevice> {
  return harness.registry.registerDevice({
    driverData,
    driverDeviceId: udid,
    provisionDuration: 0,
    spec,
  });
}

async function readyDevice(harness: Harness): Promise<VirtualDevice> {
  const device = await registeredDevice(harness);
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.ready",
    payload: { bootDuration: 0, deviceId: device.id },
  });
  return device;
}

async function shutDownDevice(harness: Harness): Promise<VirtualDevice> {
  const device = await readyDevice(harness);
  await harness.registry.transitionDevice(device.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: device.id, initiator: "test" },
  });
  return device;
}

function deviceState(harness: Harness, deviceId: string): string | undefined {
  return harness.registry.snapshot.devices.find((device) => device.id === deviceId)?.state;
}

const boot = simctl("boot", udid);
const bootstatus = simctl("bootstatus", udid, "-b");
const listapps = simctl("listapps", udid);
const shutdown = simctl("shutdown", udid);
const deleted = simctl("delete", udid);
const list = simctl("list", "-j", "devicetypes", "runtimes");
const clone = seedSimctl("clone", seedUdid, "simlock-device-1", deviceRoot);
const hungBoot: ScriptedProcessExpectation = { hangs: true, match: boot };

describe("an iOS boot under the real lease path", () => {
  it("grants a lease whose `simctl boot` answers after the generic 30 s command budget", async () => {
    const harness = await createHarness((clock) => [
      listed,
      cloned,
      { finishesOn: finishesAfter(clock, 45_000), match: simctl("boot", udid) },
      { match: simctl("bootstatus", udid, "-b") },
      { match: simctl("listapps", udid) },
    ]);

    const granted = harness.engine.request(request, requester);
    const state = promiseState(granted);
    await untilCommand(harness, "boot");
    harness.clock.advance(44_999);
    await flush();
    expect(state.state).toBe("pending");
    expect(commands(harness)).not.toContain("bootstatus");

    harness.clock.advance(1);
    const { lease } = await granted;

    expect(deviceState(harness, lease.deviceId)).toBe("leased");
    expectCalls(harness, list, clone, boot, bootstatus, listapps);
    expect(harness.runner.calls.slice(2).map((call) => call.options.timeoutMs)).toEqual([
      60_000, 120_000, 30_000,
    ]);
    expect(harness.eventBus.replay()).toContainEqual(
      expect.objectContaining({
        event: "device.ready",
        payload: expect.objectContaining({ bootDuration: 45_000, deviceId: lease.deviceId }),
      }),
    );
  });

  it.each([
    {
      case: "`simctl boot` hangs",
      phase: "boot-command",
      budgetMs: 60_000,
      script: (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        { hangs: true, match: boot, onSpawn: () => clock.advance(700) },
      ],
      steps: [{ after: "boot", advance: 60_000 }],
      expected: [boot, shutdown, deleted],
    },
    {
      case: "`bootstatus` hangs",
      phase: "bootstatus",
      budgetMs: 120_000,
      script: (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        { match: boot },
        { hangs: true, match: bootstatus, onSpawn: () => clock.advance(700) },
        { match: shutdown },
      ],
      steps: [{ after: "bootstatus", advance: 120_000 }],
      expected: [boot, bootstatus, shutdown, shutdown, deleted],
    },
    {
      case: "the installer never answers",
      phase: "installer",
      budgetMs: 120_000,
      script: (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        { match: boot },
        { finishesOn: finishesAfter(clock, 119_500), match: bootstatus },
        { hangs: true, match: listapps, onSpawn: () => clock.advance(700) },
        { match: shutdown },
      ],
      steps: [
        { after: "bootstatus", advance: 119_500 },
        { after: "listapps", advance: 500 },
      ],
      expected: [boot, bootstatus, listapps, shutdown, shutdown, deleted],
    },
  ])(
    "when $case a new device is destroyed and refused with its phase, budget and elapsed time, and the request is not retried",
    async ({ budgetMs, expected, phase, script, steps }) => {
      const harness = await createHarness((clock) => [
        listed,
        cloned,
        ...script(clock),
        { match: shutdown },
        { match: deleted },
      ]);

      const failed = harness.engine.request(request, requester).catch((error: unknown) => error);
      for (const { after, advance } of steps) {
        await untilCommand(harness, after);
        harness.clock.advance(advance);
      }
      const failure = await failed;

      const deviceId = harness.registry.snapshot.devices[0]?.id ?? "";
      const elapsedMs = budgetMs + 700;
      expect(failure).toBeInstanceOf(BootTimeoutError);
      expect(failure).toMatchObject({
        deviceId,
        diagnostics: { budgetMs, elapsedMs, phase },
        message: `Timed out waiting for device to boot: ${deviceId} [phase=${phase}, budgetMs=${String(budgetMs)}, elapsedMs=${String(elapsedMs)}]`,
      });
      expect(deviceState(harness, deviceId)).toBe("deleted");
      expectCalls(harness, list, clone, ...expected);
      expect(harness.eventBus.replay()).toContainEqual(
        expect.objectContaining({
          event: "lease.rejected",
          payload: expect.objectContaining({ reason: "boot-timeout" }),
        }),
      );
    },
  );

  it("destroys a timed-out new device without waiting for a boot child that ignored SIGTERM, and that child finishing later revives nothing", async () => {
    const harness = await createHarness((clock) => [
      listed,
      cloned,
      {
        finishesOn: finishesAfter(clock, 61_000),
        ignoresSigterm: true,
        match: simctl("boot", udid),
      },
      { match: simctl("shutdown", udid) },
      { match: simctl("delete", udid) },
    ]);

    const failed = harness.engine.request(request, requester).catch((error: unknown) => error);
    await untilCommand(harness, "boot");
    harness.clock.advance(60_000);
    expect(await failed).toBeInstanceOf(BootTimeoutError);

    const child = harness.runner.handles[2];
    const childState = promiseState(child?.wait() ?? Promise.reject(new Error("no boot child")));
    await flush();
    expect(childState.state).toBe("pending");
    expect(child?.signals).toEqual(["SIGTERM"]);
    expectCalls(harness, list, clone, boot, shutdown, deleted);

    harness.clock.advance(1_000);
    await flush();
    expect(childState.state).toBe("fulfilled");
    expectCalls(harness, list, clone, boot, shutdown, deleted);
    expect(harness.registry.snapshot.devices).toMatchObject([{ state: "deleted" }]);
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("destroys a shut-down device whose boot for a lease timed out, and refuses the request under the device's own id with the budget", async () => {
    const harness = await createHarness(() => [
      listed,
      hungBoot,
      { match: simctl("shutdown", udid) },
      { match: simctl("delete", udid) },
    ]);
    const device = await shutDownDevice(harness);

    const failed = harness.engine.request(request, requester).catch((error: unknown) => error);
    await untilCommand(harness, "boot");
    harness.clock.advance(59_999);
    await flush();
    expectCalls(harness, list, boot);

    harness.clock.advance(1);

    expect(await failed).toMatchObject({
      deviceId: device.id,
      diagnostics: { budgetMs: 60_000, elapsedMs: 60_000, phase: "boot-command" },
      name: "BootTimeoutError",
    });
    expect(deviceState(harness, device.id)).toBe("deleted");
    expectCalls(harness, list, boot, shutdown, deleted);
  });

  it("spends the initial-boot budget once on a new seed and again on its copy", async () => {
    const harness = await createHarness(
      (clock) => [
        listed,
        seedCreated,
        { finishesOn: finishesAfter(clock, 59_000), match: seedSimctl("boot", seedUdid) },
        { match: seedSimctl("bootstatus", seedUdid, "-b") },
        { match: seedSimctl("listapps", seedUdid) },
        { match: seedSimctl("shutdown", seedUdid) },
        cloned,
        { finishesOn: finishesAfter(clock, 118_000), match: simctl("boot", udid) },
        { match: simctl("bootstatus", udid, "-b") },
        { match: simctl("listapps", udid) },
      ],
      { seeded: false },
    );

    const granted = harness.engine.request(request, requester);
    await untilCommand(harness, "boot");
    harness.clock.advance(59_000);
    await untilCommand(harness, "boot", 2);
    harness.clock.advance(59_000);
    const { lease } = await granted;

    expect(deviceState(harness, lease.deviceId)).toBe("leased");
    expect(harness.clock.now() - startedAt).toBe(118_000);
    expect(harness.runner.calls[2]?.options).toEqual({ timeoutMs: 60_000 });
    expect(harness.runner.calls[7]?.options).toEqual({ timeoutMs: 60_000 });
  });

  it.each([
    {
      case: "deleting the seed works",
      deleteResult: { code: 0, stderr: "", stdout: "" },
      suffix: "",
    },
    {
      case: "deleting the seed fails too",
      deleteResult: { code: 1, stderr: "Unable to delete", stdout: "" },
      suffix: `; deleting it failed: simctl delete ${seedUdid} exited with code 1: Unable to delete`,
    },
  ])(
    "gives each attempt at a new seed its own budget, so a request outlasts 60 s, and keeps the phase as text when $case",
    async ({ deleteResult, suffix }) => {
      const seedBoot = seedSimctl("boot", seedUdid);
      const seedShutdown = seedSimctl("shutdown", seedUdid);
      const seedDelete = seedSimctl("delete", seedUdid);
      const seedAttempt = (clock: FakeClock): readonly ScriptedProcessExpectation[] => [
        seedCreated,
        { hangs: true, match: seedBoot, onSpawn: () => clock.advance(700) },
        { match: seedShutdown },
        { match: seedDelete, result: deleteResult },
      ];
      const harness = await createHarness(
        (clock) => [listed, ...seedAttempt(clock), ...seedAttempt(clock)],
        { seeded: false },
      );

      const failed = harness.engine.request(request, requester).catch((error: unknown) => error);
      await untilCommand(harness, "boot");
      harness.clock.advance(60_000);
      await untilCommand(harness, "boot", 2);
      harness.clock.advance(59_999);
      await flush();
      expect(commands(harness).filter((command) => command === "delete")).toHaveLength(1);

      harness.clock.advance(1);
      const failure = await failed;

      expect(failure).toMatchObject({ name: "ProvisionFailedError" });
      expect(failure).not.toBeInstanceOf(BootTimeoutError);
      expect((failure as Error).message).toBe(
        `seed ${seedUdid} did not boot: Timed out waiting for device to boot: device-1 [phase=boot-command, budgetMs=60000, elapsedMs=60700]${suffix}`,
      );
      expect(harness.clock.now() - startedAt).toBe(121_400);
      expect(harness.registry.snapshot.devices).toEqual([]);
      const attempt = [seedCreated.match, seedBoot, seedShutdown, seedDelete];
      expectCalls(harness, list, ...attempt, ...attempt);
    },
  );

  it("leaves a device shut down and unclaimed after its warm boot times out, with no shutdown sent", async () => {
    const harness = await createHarness(() => [hungBoot]);
    const device = await shutDownDevice(harness);
    const claim = harness.claims.tryClaim(device.id, "boot");
    if (claim === undefined) throw new Error("the device is claimed");

    const failed = harness.lifecycle.bootWarm(device, claim).catch((error: unknown) => error);
    await untilCommand(harness, "boot");
    harness.clock.advance(60_000);

    expect(await failed).toMatchObject({
      deviceId: udid,
      diagnostics: { budgetMs: 60_000, elapsedMs: 60_000, phase: "boot-command" },
      name: "BootTimeoutError",
    });
    expect(deviceState(harness, device.id)).toBe("shutdown");
    expect(harness.claims.isClaimed(device.id)).toBe(false);
    expectCalls(harness, boot);
  });

  it("keeps the lease through a recovery boot that timed out, frees the claim, and gives the next attempt its own 60 s", async () => {
    const harness = await createHarness((clock) => [
      hungBoot,
      { finishesOn: finishesAfter(clock, 119_000), match: simctl("boot", udid) },
      { match: simctl("bootstatus", udid, "-b") },
      { match: simctl("listapps", udid) },
    ]);
    const device = await readyDevice(harness);
    const lease = await harness.registry.createLease({
      deviceId: device.id,
      ownerId: requester.ownerId,
      requesterId: requester.requesterId,
      ttlDeadline: 10_000_000,
      ttlMs: 600_000,
    });

    const first = harness.lifecycle
      .recoverLeased(device, lease.id)
      .catch((error: unknown) => error);
    await untilCommand(harness, "boot");
    harness.clock.advance(60_000);

    expect(await first).toMatchObject({
      diagnostics: { budgetMs: 60_000, elapsedMs: 60_000, phase: "boot-command" },
      name: "BootTimeoutError",
    });
    expect(deviceState(harness, device.id)).toBe("leased");
    expect(harness.registry.snapshot.leases).toMatchObject([{ id: lease.id }]);
    expect(harness.claims.isClaimed(device.id)).toBe(false);

    const second = harness.lifecycle.recoverLeased(device, lease.id);
    await untilCommand(harness, "boot", 2);
    harness.clock.advance(59_000);

    await expect(second).resolves.toMatchObject({ id: device.id, state: "leased" });
    expect(harness.claims.isClaimed(device.id)).toBe(false);
    expectCalls(harness, boot, boot, bootstatus, listapps);
  });
});
