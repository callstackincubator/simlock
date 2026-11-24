import {
  FakeClock,
  FakeProcessTable,
  MemoryFilesystem,
  type ProcessEntry,
} from "../../ports/index.js";
import { createDriver } from "./test-driver-harness.js";
import { EmulatorHost, RecordingRunner } from "./test-emulator-host.js";
import {
  ANDROID_SDK_ROOT,
  avdDirectory,
  memoryAndroidSourceDatabase,
} from "./test-sdk-fixtures.js";
import { androidFilesystem } from "./test-seed-harness.js";

export const sources = `${avdDirectory}/sources`;
export const imageProperties = `${ANDROID_SDK_ROOT}/system-images/android-34/google_apis/arm64-v8a/source.properties`;
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

const ids = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

/** why: a driver with the kind's quick seed `seed_two` made and one lease's copy taken, over a machine a second driver can be opened on (a restarted daemon). */
export async function seedWorld() {
  const filesystem = await androidFilesystem({}, new HeldCopies());
  await filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=1\n");
  const host = new EmulatorHost(filesystem);
  const clock = new FakeClock();
  const table = new FakeProcessTable();
  const database = await memoryAndroidSourceDatabase();
  const driver = await createDriver(filesystem, new RecordingRunner(host.runner()), {
    clock,
    database,
    ids,
    processTable: table,
  });
  const spec = await driver.resolveSpec(request);
  await driver.provision(spec);
  return {
    clock,
    database,
    driver,
    filesystem: filesystem as HeldCopies,
    host,
    /** why: the daemon after a restart: a new driver over the same folders, table and emulators. */
    reopen: () =>
      createDriver(filesystem, host.runner(), {
        clock,
        database,
        ids: ["x1", "x2", "x3", "x4"],
        processTable: table,
      }),
    spec,
    table,
  };
}

export type SeedWorld = Awaited<ReturnType<typeof seedWorld>>;

export async function letGo(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const idle = (rootPid: number): readonly ProcessEntry[] => [
  { command: "emulator", cpuSeconds: 1, pid: rootPid, ppid: 1 },
];

/** why: a settle reads the copy's tree every 2 simulated seconds; this feeds it an idle tree and steps the clock for `steps` reads. */
export async function stepSettle(world: SeedWorld, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    const rootPid = world.host.pidAnswering("emulator-5586");
    if (rootPid !== undefined) world.table.set(idle(rootPid));
    await letGo();
    world.clock.advance(2_000);
  }
  await letGo();
}
