import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { emptyDeviceSet, setDevices, simctlInSet } from "./helpers/ios-device-set.js";

async function runtimeAndType(deviceSet: string): Promise<{ runtime: string; type: string }> {
  const runtimes = JSON.parse(
    (await simctlInSet(deviceSet, ["list", "runtimes", "-j"])).stdout,
  ) as {
    runtimes: { identifier: string; isAvailable: boolean; platform?: string }[];
  };
  const types = JSON.parse(
    (await simctlInSet(deviceSet, ["list", "devicetypes", "-j"])).stdout,
  ) as {
    devicetypes: { identifier: string; name: string }[];
  };
  const runtime = runtimes.runtimes.filter(
    (candidate) => candidate.isAvailable && (candidate.platform ?? "iOS") === "iOS",
  )[0];
  const type = types.devicetypes.find((candidate) => candidate.name.startsWith("iPhone"));
  expect(runtime, "this lane needs an installed iOS runtime").toBeDefined();
  expect(type, "this lane needs an iPhone device type").toBeDefined();
  return { runtime: runtime!.identifier, type: type!.identifier };
}

describe.skipIf(process.platform !== "darwin")(
  "simctl delete after a shutdown that did not finish (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "simctl delete removes a booted simulator whose simctl shutdown was killed before it finished",
      { timeout: 600_000 },
      async () => {
        const deviceSet = await mkdtemp(join(tmpdir(), "simlock-delete-after-shutdown-"));
        try {
          const { runtime, type } = await runtimeAndType(deviceSet);
          const udid = (
            await simctlInSet(deviceSet, ["create", "delete-after-shutdown", type, runtime])
          ).stdout.trim();
          await simctlInSet(deviceSet, ["boot", udid]);
          await simctlInSet(deviceSet, ["bootstatus", udid, "-b"], { timeoutMs: 300_000 });

          // why: the driver kills a shutdown at its limit; killing right after the start leaves
          // the simulator the way a timed-out shutdown does, with the shutdown unfinished.
          const shutdown = spawn("xcrun", ["simctl", "--set", deviceSet, "shutdown", udid]);
          const killed = new Promise<void>((resolve) => shutdown.once("close", () => resolve()));
          await new Promise((resolve) => setTimeout(resolve, 200));
          shutdown.kill("SIGKILL");
          await killed;

          await simctlInSet(deviceSet, ["delete", udid]);

          expect(await setDevices(deviceSet)).toEqual([]);
        } finally {
          await emptyDeviceSet(deviceSet);
          await rm(deviceSet, { recursive: true, force: true });
        }
      },
    );
  },
);
