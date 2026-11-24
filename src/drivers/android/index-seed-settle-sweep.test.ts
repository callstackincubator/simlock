import { describe, expect, it } from "vitest";

import { promiseState } from "../../test-support/promise-state.js";
import { letGo, seedWorld, sources, stepSettle } from "./test-seed-world.js";

function settle(world: Awaited<ReturnType<typeof seedWorld>>) {
  const started = world.driver.settleSeed?.("seed_two", { signal: new AbortController().signal });
  if (started === undefined) throw new Error("the driver offers no settleSeed");
  return started;
}

describe("AndroidDriver settle leftovers", () => {
  it("sweeps what a restart leaves of a settle, and never a settle of its own process, however long it runs", async () => {
    const running = await seedWorld();
    void settle(running);
    await stepSettle(running, 50);
    expect(
      running.host.pathAnswering("emulator-5586"),
      "the settle's copy is booted",
    ).toBeDefined();

    const restarted = await running.reopen();
    await expect(
      restarted.listSources(),
      "another process's settle row: its emulator stopped by its path, its folder and row deleted",
    ).resolves.toMatchObject([{ id: "seed_two", settled: false }]);
    expect(running.host.pathAnswering("emulator-5586")).toBeUndefined();
    await expect(running.filesystem.exists(`${sources}/seed_three`)).resolves.toBe(false);

    const retiring = await seedWorld();
    const reached = retiring.filesystem.hold(`${sources}/seed_two/`);
    const copy = retiring.driver.provision(retiring.spec);
    copy.catch(() => undefined);
    await reached;
    void settle(retiring);
    await stepSettle(retiring, 100);
    const afterRestart = await retiring.reopen();
    await expect(
      afterRestart.listSources(),
      "a retired quick seed's row and folder are deleted",
    ).resolves.toMatchObject([{ id: "seed_four", settled: true }]);
    await expect(retiring.filesystem.exists(`${sources}/seed_two`)).resolves.toBe(false);
    retiring.filesystem.open();

    const own = await seedWorld();
    const copying = own.filesystem.hold(`${sources}/seed_two/`);
    const settling = settle(own);
    await copying;
    own.clock.advance(1_300_000);
    const make = own.driver.provision(own.spec);
    make.catch(() => undefined);
    await letGo();
    await expect(
      own.filesystem.exists(`${sources}/seed_three`),
      "a make of the kind during this process's settle leaves its folder",
    ).resolves.toBe(true);
    own.filesystem.open();
    await stepSettle(own, 100);
    const ended = promiseState(settling);
    await letGo();
    expect(ended.state, "the settle went on and ended").toBe("fulfilled");
    await expect(own.driver.listSources()).resolves.toMatchObject([
      { id: "seed_three", settled: true },
    ]);
  });
});
