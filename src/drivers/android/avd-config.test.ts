import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";

// why: AvdConfig is a part of a decomposed module (ADR 0063 §2). The hash is judged against
// a stored value, so a changed input or order would make every seed stale; only a test that
// builds the part can pin it to a value no driver run would show.
describe("AvdConfig", () => {
  it("hashes a fixed config to the value it had on 059a270", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices/android/seed");
    await filesystem.writeFileAtomic(
      "/devices/android/seed/config.ini",
      [
        "hw.device.hash2=abc",
        "hw.ramSize=2048",
        "image.sysdir.1=system-images/android-35/google_apis/arm64-v8a/",
        "disk.dataPartition.size=6G",
        "skin.name=pixel",
        "simlock.mark=tok",
        "",
      ].join("\n"),
    );
    const processRunner = new ScriptedProcessRunner([]);
    const adbTools = new AdbTools({
      adb: "/sdk/adb",
      adbServerPort: 5038,
      baseEnv: {},
      clock: new FakeClock(),
      deviceRoot: "/devices/android",
      emulator: "/sdk/emulator",
      processRunner,
    });
    const hashWith = (seedLaunchInputs: readonly string[]) =>
      new AvdConfig({
        adb: "/sdk/adb",
        adbTools,
        filesystem,
        idGenerator: { generate: () => "id" },
        seedLaunchInputs,
      }).currentConfigHash(
        "/devices/android/seed",
        "system-images;android-35;google_apis;arm64-v8a@3",
        "35.4.9",
      );

    await expect(hashWith([])).resolves.toBe("8e6ae1fe");
    await expect(hashWith(["headless=true", "gpu=host"])).resolves.toBe("2be943cb");
  });
});
