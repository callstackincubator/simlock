import { describe, expect, it } from "vitest";

import {
  FakeClock,
  FakeProcessTable,
  MemoryFilesystem,
  type ProcessEntry,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  androidFilesystem,
  ANDROID_SDK_ROOT,
  avdDirectory,
  createDriver,
  EmulatorHost,
  RecordingRunner,
} from "./testing.js";

const sources = `${avdDirectory}/sources`;
const imageProperties = `${ANDROID_SDK_ROOT}/system-images/android-34/google_apis/arm64-v8a/source.properties`;
const request = { model: "Pixel 5", osVersion: "34", platform: "android" } as const;

/** why: the first copy out of a folder stops at its copy, as a copy of a multi-gigabyte AVD is still running while other calls arrive, until the test opens it. */
class HeldCopies extends MemoryFilesystem {
  #holdFrom: string | undefined;
  #reached = (): void => undefined;
  #opened: Promise<void> = Promise.resolve();
  open = (): void => undefined;

  hold(from: string): Promise<void> {
    this.#holdFrom = from;
    this.#opened = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    return new Promise<void>((resolve) => {
      this.#reached = resolve;
    });
  }

  override async copyTree(from: string, to: string, options: { readonly timeoutMs: number }) {
    if (this.#holdFrom !== undefined && from.startsWith(this.#holdFrom)) {
      this.#holdFrom = undefined;
      this.#reached();
      await this.#opened;
    }
    return super.copyTree(from, to, options);
  }
}

async function world() {
  const filesystem = await androidFilesystem({}, new HeldCopies());
  await filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=1\n");
  const host = new EmulatorHost(filesystem);
  const clock = new FakeClock();
  const table = new FakeProcessTable();
  const driver = await createDriver(filesystem, new RecordingRunner(host.runner()), {
    clock,
    ids: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
    processTable: table,
  });
  const spec = await driver.resolveSpec(request);
  await driver.provision(spec);
  return { clock, driver, filesystem: filesystem as HeldCopies, host, spec, table };
}

async function letGo(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const idle = (rootPid: number): readonly ProcessEntry[] => [
  { command: "emulator", cpuSeconds: 1, pid: rootPid, ppid: 1 },
];

describe("AndroidDriver seed turns", () => {
  it("makes a seed's deletion wait for the copies in flight, and a copy asked for after it began copy the kind's current seed", async () => {
    type World = Awaited<ReturnType<typeof world>>;
    const stale = async (w: World) => {
      await w.filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=2\n");
      return w.driver.provision(w.spec);
    };
    const destroy = async (w: World) => w.driver.destroySource("seed_two");
    const swap = async (w: World) => {
      const settle = w.driver.settleSeed?.("seed_two", { signal: new AbortController().signal });
      if (settle === undefined) throw new Error("the driver offers no settleSeed");
      return settle;
    };
    /** why: a settle needs 3 simulated minutes of idle readings before it swaps; the others need none. */
    const drive = async (w: World, name: string) => {
      for (let step = 0; step < (name === "a settle's swap" ? 100 : 0); step += 1) {
        const rootPid = w.host.pidAnswering("emulator-5586");
        if (rootPid !== undefined) w.table.set(idle(rootPid));
        await letGo();
        w.clock.advance(2_000);
      }
      await letGo();
    };
    for (const [name, deletion] of [
      ["a stale seed's remake", stale],
      ["destroySource", destroy],
      ["a settle's swap", swap],
    ] as const) {
      const w = await world();
      const reached = w.filesystem.hold(`${sources}/seed_two/`);
      const copy = w.driver.provision(w.spec);
      await reached;

      const deleting = deletion(w);
      const deleted = promiseState(deleting);
      await drive(w, name);

      expect(deleted.state, `${name}: waits for the copy in flight`).toBe("pending");
      await expect(
        w.filesystem.exists(`${sources}/seed_two/simlock.avd`),
        `${name}: the seed's folder stays while a copy runs from it`,
      ).resolves.toBe(true);
      const after = w.driver.provision(w.spec);
      w.filesystem.open();
      const device = await copy;
      await expect(
        w.filesystem.exists(`${avdDirectory}/${device.deviceId}/simlock.avd/config.ini`),
        `${name}: the copy in flight completed`,
      ).resolves.toBe(true);
      await deleting;
      const later = await after;
      await expect(
        w.filesystem.exists(`${avdDirectory}/${later.deviceId}/simlock.avd/config.ini`),
        `${name}: a copy asked for after the deletion began is a whole copy`,
      ).resolves.toBe(true);
      await expect(
        w.filesystem.exists(`${sources}/seed_two`),
        `${name}: the seed's folder is gone once its copies ended`,
      ).resolves.toBe(false);
    }
  });
});
