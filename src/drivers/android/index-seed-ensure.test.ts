import { describe, expect, it } from "vitest";

import {
  androidFilesystem,
  ANDROID_SDK_ROOT,
  avdDirectory,
  createDriver,
  EmulatorHost,
  RecordingRunner,
} from "./testing.js";

const imageProperties = `${ANDROID_SDK_ROOT}/system-images/android-34/google_apis/arm64-v8a/source.properties`;
const request = { model: "Pixel 5", osVersion: "34", platform: "android" } as const;

describe("AndroidDriver ensureSeed", () => {
  it("answers the kind's fresh seed, or makes it as a provision would, without creating a device", async () => {
    const filesystem = await androidFilesystem();
    await filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=1\n");
    const runner = new RecordingRunner(new EmulatorHost(filesystem).runner());
    const driver = await createDriver(filesystem, runner, { ids: ["one", "two", "three", "four"] });
    const spec = await driver.resolveSpec(request);
    const ensure = () => {
      const ensured = driver.ensureSeed?.(spec);
      if (ensured === undefined) throw new Error("the driver offers no ensureSeed");
      return ensured;
    };
    const made = () => runner.calls.filter((call) => call.args[0] === "create").length;

    const [first, second] = await Promise.all([ensure(), ensure()]);
    expect([first.sourceId, second.sourceId], "two calls at once make one seed").toEqual([
      "seed_one",
      "seed_one",
    ]);
    expect(made(), "none: the seed is made").toBe(1);
    expect(first).toMatchObject({ leases: 0, settled: false });
    await expect(
      filesystem.readdir(avdDirectory),
      "no device folder is created",
    ).resolves.not.toContainEqual(expect.stringMatching(/^simlock_/));

    await expect(ensure(), "fresh: answered as it is").resolves.toMatchObject({
      sourceId: "seed_one",
    });
    expect(made(), "fresh: nothing is made again").toBe(1);

    await filesystem.writeFileAtomic(imageProperties, "Pkg.Revision=2\n");
    await expect(ensure(), "stale: remade").resolves.toMatchObject({ sourceId: "seed_two" });
    expect(made()).toBe(2);
    await expect(driver.listSources()).resolves.toMatchObject([{ id: "seed_two" }]);
  });
});
