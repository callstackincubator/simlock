import { describe, expect, it } from "vitest";

import { FakeClock, FakeProcessTable, type ProcessEntry } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  androidFilesystem,
  avdDirectory,
  createDriver,
  EmulatorHost,
  RecordingRunner,
} from "./testing.js";

const sources = `${avdDirectory}/sources`;

/** why: the quick seed `seed_two` is made and copied by a plain provision, as a first lease makes it; the settle's own folder is `seed_three`. */
async function quickSeedWorld() {
  const filesystem = await androidFilesystem();
  const host = new EmulatorHost(filesystem);
  const runner = new RecordingRunner(host.runner());
  const clock = new FakeClock();
  const table = new FakeProcessTable();
  const driver = await createDriver(filesystem, runner, {
    clock,
    ids: ["one", "two", "three", "four"],
    processTable: table,
  });
  await driver.provision(
    await driver.resolveSpec({ model: "Pixel 5", osVersion: "34", platform: "android" }),
  );
  return { clock, driver, filesystem, host, runner, table };
}

type World = Awaited<ReturnType<typeof quickSeedWorld>>;

/** why: the booted copy's tree as a process table prints it: the emulator the driver spawned and its qemu, using one core for the first minute and none after. */
function emulatorTree(
  rootPid: number,
  nowMs: number,
  busyUntilMs: number,
): readonly ProcessEntry[] {
  const busySeconds = Math.min(nowMs, busyUntilMs) / 1_000;
  return [
    { command: "emulator -avd simlock", cpuSeconds: 0.5, pid: rootPid, ppid: 1 },
    { command: "qemu-system", cpuSeconds: busySeconds, pid: 9_000, ppid: rootPid },
  ];
}

/** why: the fake clock never moves by itself; the poll waits on a timer, so the test steps it until the settle ends, and hands each step's time to the case. */
async function runToEnd(
  settle: Promise<unknown>,
  world: {
    readonly clock: FakeClock;
    readonly host: EmulatorHost;
    readonly table: FakeProcessTable;
  },
  busyUntilMs: number,
  atStep: (nowMs: number) => void,
  ends: "fulfilled" | "rejected" = "fulfilled",
): Promise<void> {
  const state = promiseState(settle);
  for (let step = 0; step < 600 && state.state === "pending"; step += 1) {
    const rootPid = world.host.pidAnswering("emulator-5586");
    if (rootPid !== undefined)
      world.table.set(emulatorTree(rootPid, world.clock.now(), busyUntilMs));
    atStep(world.clock.now());
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (state.state === "pending") world.clock.advance(2_000);
  }
  expect(state.state, "the settle ended within 20 simulated minutes").toBe(ends);
}

/** why: how the guest's network comes up in each case: `dumpsys connectivity` names a default network from the start, or the log announces one at a time while `dumpsys` still says none. */
const cases = [
  {
    announcedAtMs: 10_000,
    busyUntilMs: 60_000,
    reason: "idle",
    name: "idle at 180 s, the listener fired at 10 s",
    network: undefined,
    settledAfterMs: 180_000,
  },
  {
    announcedAtMs: undefined,
    busyUntilMs: 60_000,
    reason: "idle",
    name: "idle at 180 s, the listener never fired but dumpsys connectivity shows a default network",
    network: 100,
    settledAfterMs: 180_000,
  },
  {
    announcedAtMs: 300_000,
    busyUntilMs: 60_000,
    reason: "idle",
    name: "idle at 180 s with no default network yet: the save waits for the listener",
    network: undefined,
    settledAfterMs: 300_000,
  },
  {
    announcedAtMs: undefined,
    busyUntilMs: 60_000,
    reason: "cap",
    name: "idle at 180 s but no default network by the cap: saved at 900 s",
    network: undefined,
    settledAfterMs: 900_000,
  },
  {
    announcedAtMs: undefined,
    busyUntilMs: 850_000,
    reason: "cap",
    name: "idle only at the cap: saved at 900 s",
    network: 100,
    settledAfterMs: 900_000,
  },
  {
    announcedAtMs: undefined,
    busyUntilMs: Number.POSITIVE_INFINITY,
    reason: "cap",
    name: "still busy at the cap: saved at 900 s",
    network: 100,
    settledAfterMs: 900_000,
  },
] as const;

/** why: the settle of a source, as core asks for it. */
function startSettle(world: World, sourceId: string): Promise<unknown> {
  const started = world.driver.settleSeed?.(sourceId, { signal: new AbortController().signal });
  if (started === undefined) throw new Error("the driver offers no settleSeed");
  return started;
}

async function letGo(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise<void>((r) => setImmediate(r));
}

describe("AndroidDriver settleSeed", () => {
  it("saves an idle copy's snapshot as the seed", async () => {
    for (const scenario of cases) {
      const world = await quickSeedWorld();
      world.host.defaultNetwork = scenario.network;
      const callsBefore = world.runner.calls.length;
      const saved = () =>
        world.runner.calls
          .slice(callsBefore)
          .some(
            (call) => call.args.join(" ") === "-s emulator-5586 emu avd snapshot save simlock_boot",
          );
      let savedBeforeAnnouncement: boolean | undefined;

      const settle = world.driver.settleSeed?.("seed_two", {
        signal: new AbortController().signal,
      });
      if (settle === undefined) throw new Error("the driver offers no settleSeed");
      await runToEnd(settle, world, scenario.busyUntilMs, (nowMs) => {
        if (nowMs !== scenario.announcedAtMs) return;
        savedBeforeAnnouncement = saved();
        world.host.announceDefaultNetwork();
      });

      await expect(settle, scenario.name).resolves.toMatchObject({
        reason: scenario.reason,
        settledAfterMs: scenario.settledAfterMs,
        sourceId: "seed_three",
      });
      if (scenario.announcedAtMs !== undefined && scenario.announcedAtMs > 180_000) {
        expect(
          savedBeforeAnnouncement,
          `${scenario.name}: nothing was saved before the log line`,
        ).toBe(false);
      }
      await expect(
        world.filesystem.exists(`${sources}/seed_two`),
        `${scenario.name}: the quick seed's folder is deleted when the settle returns`,
      ).resolves.toBe(false);
      await expect(world.filesystem.exists(`${sources}/seed_three/simlock.avd`)).resolves.toBe(
        true,
      );
      const listed = await world.driver.listSources();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: "seed_three", kind: "seed", settled: true });
      expect(listed[0]).not.toHaveProperty("staleReason");
      expect(world.host.openLogcats, "the network listener is closed").toBe(0);
      const after = world.runner.calls.slice(callsBefore);
      expect(
        after.some(
          (call) =>
            call.args.includes("-snapshot") &&
            call.args[call.args.indexOf("-snapshot") + 1] === "simlock_boot",
        ),
        "the copy booted from the quick seed's snapshot",
      ).toBe(true);
      expect(saved(), "the snapshot was saved again in the booted copy").toBe(true);
      expect(
        world.host.pathAnswering("emulator-5586"),
        "the copy's emulator was stopped",
      ).toBeUndefined();
    }
  });

  it("serves a provision of the kind from the quick seed while its settle runs", async () => {
    const world = await quickSeedWorld();
    const settle = world.driver.settleSeed?.("seed_two", { signal: new AbortController().signal });
    if (settle === undefined) throw new Error("the driver offers no settleSeed");
    const settling = settle.catch((error: unknown) => error);
    for (let tick = 0; tick < 20; tick += 1) await new Promise<void>((r) => setImmediate(r));

    const provisioned = world.driver.provision(
      await world.driver.resolveSpec({ model: "Pixel 5", osVersion: "34", platform: "android" }),
    );
    const state = promiseState(provisioned);
    for (let tick = 0; tick < 50 && state.state === "pending"; tick += 1)
      await new Promise<void>((r) => setImmediate(r));

    expect(state.state, "the provision did not wait for the settle").toBe("fulfilled");
    await expect(world.filesystem.exists(`${sources}/seed_two/simlock.avd`)).resolves.toBe(true);
    await runToEnd(settling, world, 60_000, () => undefined);
  });

  it("throws and leaves the quick seed when the save does not list, the emulator exits or the settle is aborted", async () => {
    const controller = new AbortController();
    const stopping = new Error("the daemon is stopping");
    const scenarios = [
      {
        verify: (error: unknown) =>
          expect((error as Error).message).toMatch(/boot snapshot simlock_boot was not saved/),
        name: "a snapshot that is not listed",
        prepare: (world: World) => {
          world.host.snapshotListing = "";
        },
      },
      {
        atStep: (nowMs: number, world: World) => {
          if (nowMs === 10_000) world.host.crash("emulator-5586");
        },
        verify: (error: unknown) => expect((error as Error).message).toMatch(/exited/),
        name: "an emulator that exits early",
      },
      {
        atStep: (nowMs: number) => {
          if (nowMs === 100_000) controller.abort(stopping);
        },
        verify: (error: unknown) => expect(error).toBe(stopping),
        name: "an abort",
      },
    ];
    for (const scenario of scenarios) {
      const world = await quickSeedWorld();
      scenario.prepare?.(world);

      const settle = world.driver.settleSeed?.("seed_two", { signal: controller.signal });
      if (settle === undefined) throw new Error("the driver offers no settleSeed");
      const outcome = settle.catch((error: unknown) => error);
      await runToEnd(outcome, world, 60_000, (nowMs) => scenario.atStep?.(nowMs, world));

      const error = await outcome;
      scenario.verify(error);
      await expect(
        world.filesystem.exists(`${sources}/seed_three`),
        `${scenario.name}: the settle's folder is deleted at once`,
      ).resolves.toBe(false);
      await expect(
        world.driver.listSources(),
        `${scenario.name}: the quick seed is still the kind's seed`,
      ).resolves.toMatchObject([{ id: "seed_two", settled: false }]);
      await expect(world.filesystem.exists(`${sources}/seed_two/simlock.avd`)).resolves.toBe(true);
      expect(
        world.host.pathAnswering("emulator-5586"),
        `${scenario.name}: nothing runs`,
      ).toBeUndefined();
    }
  });

  it("refuses a source that is no ready quick seed", async () => {
    const refused = await quickSeedWorld();
    await runToEnd(startSettle(refused, "seed_two"), refused, 60_000, () => undefined);
    for (const sourceId of ["seed_nope", "seed_three"]) {
      await expect(startSettle(refused, sourceId), sourceId).rejects.toThrow(
        `Android keeps no ready quick seed ${sourceId}`,
      );
    }

    const running = await quickSeedWorld();
    const settling = startSettle(running, "seed_two");
    await letGo();
    const second = startSettle(running, "seed_three");
    const answer = promiseState(second.catch((error: unknown) => error));
    await letGo();
    expect(answer.state, "a settle that is still making is refused at once").toBe("fulfilled");
    await expect(second).rejects.toThrow("Android keeps no ready quick seed seed_three");
    await runToEnd(settling, running, 60_000, () => undefined);

    const filesystem = await androidFilesystem();
    const withoutTable = await createDriver(
      filesystem,
      new RecordingRunner(new EmulatorHost(filesystem).runner()),
    );
    expect(withoutTable.settleSeed, "a driver given no process table offers no settle").toBe(
      undefined,
    );
  });
});
