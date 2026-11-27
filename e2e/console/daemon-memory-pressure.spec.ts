import {
  type ConsoleDaemon,
  disposeFleet,
  expect,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

/**
 * why: reproduces #1928. A worker reads this host's real memory (ADR 0068); at `warming-paused` its
 * warm pool starts nothing, so a console spec that waits for a refill right after a grant fails on a
 * loaded host. The config the fixture writes is the one place a console daemon can be kept off the
 * host's memory, and `config get` reads what the running worker loaded from it. Both ways the
 * fixture starts a worker are covered: alone, and joined to a gateway by `startFleet`.
 */

async function memoryPressureEnabled(worker: ConsoleDaemon): Promise<unknown> {
  const read = await worker.cli(["config", "get", "memoryPressure.enabled"]);
  expect(read.code, read.stderr).toBe(0);
  return read.json;
}

test("a standalone worker the console fixture starts has memory pressure turned off", async () => {
  const worker = await startDaemon("worker");
  try {
    expect(await memoryPressureEnabled(worker), "memoryPressure.enabled on the worker").toBe(false);
  } finally {
    await worker.dispose();
  }
});

test("a worker the console fixture joins to a gateway has memory pressure turned off", async () => {
  const fleet = await startFleet([{ label: "mac-a" }]);
  try {
    const [worker] = fleet.workers;
    expect(
      await memoryPressureEnabled(worker!),
      "memoryPressure.enabled on the joined worker",
    ).toBe(false);
  } finally {
    await disposeFleet(fleet);
  }
});
