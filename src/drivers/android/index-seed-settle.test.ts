import { describe, expect, it } from "vitest";

import {
  FakeClock,
  FakeProcessTable,
  type MemoryFilesystem,
  type ProcessEntry,
} from "../../ports/index.js";
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
    ids: ["one", "two", "three"],
    processTable: table,
  });
  await driver.provision(
    await driver.resolveSpec({ model: "Pixel 5", osVersion: "34", platform: "android" }),
  );
  return { clock, driver, filesystem, host, runner, table };
}

/** why: the booted copy's tree as a process table prints it: the emulator the driver spawned and its qemu, using one core for the first minute and none after. */
function emulatorTree(rootPid: number, nowMs: number): readonly ProcessEntry[] {
  const busySeconds = Math.min(nowMs, 60_000) / 1_000;
  return [
    { command: "emulator -avd simlock", cpuSeconds: 0.5, pid: rootPid, ppid: 1 },
    { command: "qemu-system", cpuSeconds: busySeconds, pid: 9_000, ppid: rootPid },
  ];
}

/** why: the fake clock never moves by itself; the poll waits on a timer, so the test steps it until the settle ends. */
async function runToEnd(
  settle: Promise<unknown>,
  world: {
    readonly clock: FakeClock;
    readonly host: EmulatorHost;
    readonly table: FakeProcessTable;
  },
): Promise<void> {
  const state = promiseState(settle);
  for (let step = 0; step < 600 && state.state === "pending"; step += 1) {
    const rootPid = world.host.pidAnswering("emulator-5586");
    if (rootPid !== undefined) world.table.set(emulatorTree(rootPid, world.clock.now()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (state.state === "pending") world.clock.advance(2_000);
  }
  expect(state.state, "the settle ended within 20 simulated minutes").toBe("fulfilled");
}

async function exists(filesystem: MemoryFilesystem, path: string): Promise<boolean> {
  return filesystem.exists(path);
}

describe("AndroidDriver settleSeed", () => {
  it("saves an idle copy's snapshot as the seed", async () => {
    const world = await quickSeedWorld();
    const callsBefore = world.runner.calls.length;

    const settle = world.driver.settleSeed?.("seed_two", { signal: new AbortController().signal });
    if (settle === undefined) throw new Error("the driver offers no settleSeed");
    await runToEnd(settle, world);

    await expect(settle).resolves.toMatchObject({
      reason: "idle",
      settledAfterMs: 180_000,
      sourceId: "seed_three",
    });
    const listed = await world.driver.listSources();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "seed_three", kind: "seed", settled: true });
    expect(listed[0]).not.toHaveProperty("staleReason");
    await expect(exists(world.filesystem, `${sources}/seed_two`)).resolves.toBe(false);
    await expect(exists(world.filesystem, `${sources}/seed_three/simlock.avd`)).resolves.toBe(true);
    const after = world.runner.calls.slice(callsBefore);
    expect(
      after.some(
        (call) =>
          call.args.includes("-snapshot") &&
          call.args[call.args.indexOf("-snapshot") + 1] === "simlock_boot",
      ),
      "the copy booted from the quick seed's snapshot",
    ).toBe(true);
    expect(
      after.some(
        (call) => call.args.join(" ") === "-s emulator-5586 emu avd snapshot save simlock_boot",
      ),
      "the snapshot was saved again in the booted copy",
    ).toBe(true);
    expect(
      world.host.pathAnswering("emulator-5586"),
      "the copy's emulator was stopped",
    ).toBeUndefined();
  });
});
