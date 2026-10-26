import { describe, expect, it } from "vitest";

import {
  freeLoopbackPort,
  openInputSocket,
  waitFor,
  withDaemon,
  type TestEnv,
} from "./helpers/index.js";

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

async function startDaemon(): Promise<TestEnv & { readonly port: number }> {
  const port = await freeLoopbackPort();
  const env = await withDaemon({
    configOverrides: {
      capabilities: { input: { enabled: true } },
      health: { probeIntervalMs: 2_000, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
    },
    driver: "real",
  });
  return Object.assign(env, { port });
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

    it(
      "a tap sent through the lease's input socket lands on the phone, which the person confirms",
      { timeout: 10 * MINUTE },
      async () => {
        const env = await startDaemon();
        const added = await env.cli(["device", "add", "--platform", "android", serial, "--json"], {
          timeout: 2 * MINUTE,
        });
        expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
        await expectAfterPrompt(env, serial, "unlock the phone and keep it plugged in", "ready");
        // why: the lease is opened through the CLI, so its holder is not an agent token minted here; an
        // operator token can open any lease's input socket.
        const created = await env.cli(["token", "create", "--role", "operator"]);
        const { secret } = created.json as { secret: string };
        const leased = await env.cli(
          [
            "lease",
            "--platform",
            "android",
            "--physical",
            "--agent-id",
            "manual-input",
            "--detach",
          ],
          { timeout: 5 * MINUTE },
        );
        expect(leased.code, `lease failed: ${leased.stderr}`).toBe(0);
        const leaseId = (leased.json as { lease: { id: string } }).lease.id;
        const socket = await openInputSocket(env.port, leaseId, secret);
        try {
          const config = (await socket.waitForTag(0x82)) as { inputUnavailable?: true };
          expect(config.inputUnavailable).toBeUndefined();
          console.info(
            `\n>>> WATCH THE PHONE: a tap lands at the centre of its screen in 10 s (confirm by eye)\n`,
          );
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          socket.send(0x03, { type: "begin", x: 0.5, y: 0.5 });
          socket.send(0x03, { type: "end", x: 0.5, y: 0.5 });
          await new Promise((resolve) => setTimeout(resolve, PERSON_STEP_MS / 3));
        } finally {
          socket.close();
          await env.cli(["release", leaseId]);
        }
      },
    );
  },
);
