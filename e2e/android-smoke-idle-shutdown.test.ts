import { describe, expect, it } from "vitest";

import { waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

// why: the slow Android smoke (`slow-android-smoke.test.ts`) waits for its released emulator to
// be demoted to `shutdown` by `cleanup`. This runs the same lease, release and cleanup under the
// same config overrides with the fake driver, so whether `cleanup` demotes the device at all is
// decided here in seconds rather than by a 60-second timeout on a real emulator (#1087).
const SLOW_ANDROID_SMOKE_CONFIG = { idle: { shutdownAfterMs: 300 } } as const;

interface DeviceRow {
  readonly driverDeviceId: string;
  readonly state: string;
}

async function stateOf(env: TestEnv, driverDeviceId: string): Promise<string | undefined> {
  const listed = await env.cli(["list", "--devices"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as DeviceRow[]).find((row) => row.driverDeviceId === driverDeviceId)?.state;
}

describe("the slow Android smoke's idle shutdown", () => {
  it("with the slow Android smoke's config, cleanup demotes a released Pixel 9 that has been idle past idle.shutdownAfterMs to shutdown", async () => {
    const env = await withDaemon({
      configOverrides: SLOW_ANDROID_SMOKE_CONFIG,
      driverScript: { android: { availableOsVersions: ["35"], knownModels: ["Pixel 9"] } },
    });

    const lease = await env.cli([
      "lease",
      "--platform",
      "android",
      "--device",
      "Pixel 9",
      "--agent-id",
      "android-smoke",
      "--detach",
    ]);
    expect(lease.code, lease.stderr).toBe(0);
    const grant = lease.json as {
      device: { driverDeviceId: string };
      lease: { id: string };
    };
    const avdName = grant.device.driverDeviceId;

    expect((await env.cli(["release", grant.lease.id])).code).toBe(0);
    await waitFor(async () => (await stateOf(env, avdName)) === "ready", {
      label: "the released device is reclaimed to ready",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect((await env.cli(["cleanup"])).code).toBe(0);

    expect(await stateOf(env, avdName), "cleanup must demote the idle released device").toBe(
      "shutdown",
    );
  });
});
