import { describe, expect, it } from "vitest";

import { MemoryFilesystem, NodeSqliteOpener } from "../../ports/index.js";
import {
  androidFilesystem,
  androidSourceDataOwner,
  createDriver,
  EmulatorHost,
  memoryAndroidSourceDatabase,
  RecordingRunner,
} from "./testing.js";

class FailingCopies extends MemoryFilesystem {
  failing = false;

  override copyTree(from: string, to: string, options: { readonly timeoutMs: number }) {
    if (this.failing) return Promise.reject(new Error("ENOSPC"));
    return super.copyTree(from, to, options);
  }
}

const request = { model: "Pixel 5", osVersion: "34", platform: "android" } as const;

describe("AndroidDriver seed lease count", () => {
  it("adds one to its seed's lease count for a plain lease, and none for a baseline copy or a copy that fails", async () => {
    const filesystem = await androidFilesystem({}, new FailingCopies());
    const host = new EmulatorHost(filesystem);
    const driver = await createDriver(filesystem, new RecordingRunner(host.runner()), {
      database: await memoryAndroidSourceDatabase(),
      ids: ["one", "two", "three", "four", "five", "six", "seven"],
    });
    const spec = await driver.resolveSpec(request);
    const leases = async () =>
      (await driver.listSources()).filter((source) => source.kind === "seed")[0];

    const first = await driver.provision(spec);
    expect(await leases(), "the first lease of a new kind: made, copied, counted").toMatchObject({
      leases: 1,
      settled: false,
    });

    await driver.provision(spec);
    expect(await leases(), "a second plain lease").toMatchObject({ leases: 2 });

    const ready = await driver.makeReady(first);
    const baseline = await driver.saveSource({ ...ready, physical: false as const });
    await driver.provision(spec, { source: baseline.sourceId });
    expect(await leases(), "a copy of a baseline is no lease of the seed").toMatchObject({
      leases: 2,
    });

    (filesystem as FailingCopies).failing = true;
    await expect(driver.provision(spec)).rejects.toThrow("ENOSPC");
    (filesystem as FailingCopies).failing = false;
    expect(await leases(), "a copy that fails counts nothing").toMatchObject({ leases: 2 });

    const database = await new NodeSqliteOpener().open(":memory:", { readOnly: false });
    for (const migration of androidSourceDataOwner.migrations.slice(0, 2)) database.exec(migration);
    database
      .prepare(
        `INSERT INTO android_source_data (source_id, kind, state, spec_key, model, os_version, image_tag,
           folder, avd_name, image_identity, emulator_version, config_hash, created_at)
         VALUES ('seed_old', 'seed', 'ready', 'Pixel 5|system-images;android-34;google_apis;arm64-v8a',
           'Pixel 5', '34', 'google_apis', '/root/sources/seed_old', 'simlock', 'image@1', 'v', 'h', 1)`,
      )
      .run();
    for (const migration of androidSourceDataOwner.migrations.slice(2)) database.exec(migration);
    const older = await androidFilesystem();
    const reopened = await createDriver(older, new EmulatorHost(older).runner(), { database });

    await expect(reopened.listSources(), "a seed from before this feature").resolves.toMatchObject([
      { id: "seed_old", leases: 0, settled: false },
    ]);
  });
});
