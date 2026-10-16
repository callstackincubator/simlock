import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

const SERIAL = process.env["SIMLOCK_PHYSICAL_ANDROID"];
const APK = process.env["SIMLOCK_PHYSICAL_ANDROID_APK"];
const PERSON = process.env["SIMLOCK_PHYSICAL_PERSON"];

const PERSON_STEP_MS = 150_000;
const MINUTE = 60_000;

const missing =
  SERIAL === undefined || SERIAL === ""
    ? "SIMLOCK_PHYSICAL_ANDROID"
    : APK === undefined || APK === ""
      ? "SIMLOCK_PHYSICAL_ANDROID_APK"
      : PERSON !== "1"
        ? "SIMLOCK_PHYSICAL_PERSON=1"
        : undefined;

interface StatusDevice {
  readonly driverDeviceId?: string;
  readonly state: string;
  readonly absentReason?: string;
}

async function startDaemon(): Promise<TestEnv> {
  const port = await freeLoopbackPort();
  return withDaemon({
    configOverrides: {
      health: { probeIntervalMs: 2_000, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
    },
    driver: "real",
  });
}

async function deviceOf(env: TestEnv, serial: string): Promise<StatusDevice | undefined> {
  const status = await env.cli(["status", "--json"]);
  if (status.code !== 0) throw new Error(`simlock status failed: ${status.stderr}`);
  return (status.json as { devices: StatusDevice[] }).devices.find(
    (device) => device.driverDeviceId === serial,
  );
}

async function expectAfterPrompt(
  env: TestEnv,
  serial: string,
  prompt: string,
  state: string,
  absentReason?: string,
): Promise<void> {
  console.info(`\n>>> ACTION NEEDED within ${String(PERSON_STEP_MS / 1000)} s: ${prompt}\n`);
  await waitFor(
    async () => {
      const device = await deviceOf(env, serial);
      return (
        device?.state === state &&
        (absentReason === undefined || device.absentReason === absentReason)
      );
    },
    {
      interval: 1_000,
      label: `after "${prompt}": device ${serial} is ${state}${absentReason === undefined ? "" : ` (${absentReason})`}`,
      timeout: PERSON_STEP_MS,
    },
  );
}

describe.skipIf(missing !== undefined)(
  missing === undefined
    ? "Android physical phone with a person (real adb)"
    : `Android physical phone with a person (skipped: ${missing} is not set)`,
  { tags: ["slow", "android", "physical-manual"] },
  () => {
    const serial = SERIAL as string;

    it(
      "with a short health.probeIntervalMs, the phone unplugged when the test asks in its log becomes absent with absentReason not-present within 150 s, and plugged back becomes ready",
      { timeout: 10 * MINUTE },
      async () => {
        const env = await startDaemon();
        const added = await env.cli(["device", "add", "--platform", "android", serial, "--json"], {
          timeout: 2 * MINUTE,
        });
        expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
        await expectAfterPrompt(env, serial, "keep the phone plugged in", "ready");

        await expectAfterPrompt(env, serial, "UNPLUG the phone now", "absent", "not-present");

        await expectAfterPrompt(env, serial, "PLUG the phone back in now", "ready");
      },
    );
  },
);
