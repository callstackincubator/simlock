import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const UDID = process.env["SIMLOCK_PHYSICAL_IOS"];
const APP = process.env["SIMLOCK_PHYSICAL_IOS_APP"];
const PERSON = process.env["SIMLOCK_PHYSICAL_PERSON"];

const PERSON_STEP_MS = 150_000;
const MINUTE = 60_000;

const missing =
  UDID === undefined || UDID === ""
    ? "SIMLOCK_PHYSICAL_IOS"
    : APP === undefined || APP === ""
      ? "SIMLOCK_PHYSICAL_IOS_APP"
      : PERSON !== "1"
        ? "SIMLOCK_PHYSICAL_PERSON=1"
        : undefined;

interface StatusDevice {
  readonly driverDeviceId?: string;
  readonly state: string;
  readonly absentReason?: string;
}

async function startDaemon(
  options: { stream?: boolean } = {},
): Promise<TestEnv & { port: number }> {
  const port = await freeLoopbackPort();
  const env = await withDaemon({
    configOverrides: {
      ...(options.stream === true
        ? {
            capabilities: {
              stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
            },
          }
        : {}),
      health: { probeIntervalMs: 2_000, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
    },
    driver: "real",
  });
  return { ...env, port };
}

async function deviceOf(env: TestEnv, udid: string): Promise<StatusDevice | undefined> {
  const status = await env.cli(["status", "--json"]);
  if (status.code !== 0) throw new Error(`simlock status failed: ${status.stderr}`);
  return (status.json as { devices: StatusDevice[] }).devices.find(
    (device) => device.driverDeviceId === udid,
  );
}

async function expectAfterPrompt(
  env: TestEnv,
  udid: string,
  prompt: string,
  state: string,
  absentReason?: string,
): Promise<void> {
  console.info(`\n>>> ACTION NEEDED within ${String(PERSON_STEP_MS / 1000)} s: ${prompt}\n`);
  await waitFor(
    async () => {
      const device = await deviceOf(env, udid);
      return (
        device?.state === state &&
        (absentReason === undefined || device.absentReason === absentReason)
      );
    },
    {
      interval: 1_000,
      label: `after "${prompt}": device ${udid} is ${state}${absentReason === undefined ? "" : ` (${absentReason})`}`,
      timeout: PERSON_STEP_MS,
    },
  );
}

async function enroll(env: TestEnv, id: string): Promise<void> {
  const added = await env.cli(["device", "add", "--platform", "ios", id, "--json"], {
    timeout: 2 * MINUTE,
  });
  expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
}

/** why: `pgrep -x` matches the program's own name only; a pattern match would also find the shell running this check. */
async function deviceCapturesRunning(): Promise<number> {
  const found = await execFileAsync("pgrep", ["-x", "simlock-device-capture"]).catch(() => ({
    stdout: "",
  }));
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

describe.skipIf(process.platform !== "darwin" || missing !== undefined)(
  missing === undefined
    ? "iOS physical phone with a person (real devicectl)"
    : `iOS physical phone with a person (skipped: ${missing} is not set)`,
  { tags: ["slow", "ios", "physical-manual"] },
  () => {
    const udid = UDID as string;

    it(
      "after the prompt to lock the phone, the device becomes absent with absentReason locked within 150 s, and once unlocked it is reclaimed back to ready",
      { timeout: 10 * MINUTE },
      async () => {
        const env = await startDaemon();
        await enroll(env, udid);
        await expectAfterPrompt(env, udid, "keep the phone unlocked and plugged in", "ready");

        await expectAfterPrompt(env, udid, "LOCK the phone now", "absent", "locked");

        await expectAfterPrompt(env, udid, "UNLOCK the phone now", "ready");
      },
    );

    it(
      "after the prompt to unplug the phone during a lease, the lease ends device-lost and the device becomes absent with absentReason not-present within 150 s, and once plugged in and unlocked it is ready again",
      { timeout: 10 * MINUTE },
      async () => {
        const env = await startDaemon();
        await enroll(env, udid);
        await expectAfterPrompt(env, udid, "keep the phone unlocked and plugged in", "ready");
        const leased = await env.cli(
          [
            "lease",
            "--platform",
            "ios",
            "--physical",
            "--agent-id",
            "phone-lane-unplug",
            "--detach",
          ],
          { timeout: 2 * MINUTE },
        );
        expect(leased.code, `lease failed: ${leased.stderr}`).toBe(0);
        const leaseId = (leased.json as { lease: { id: string } }).lease.id;

        await expectAfterPrompt(env, udid, "UNPLUG the phone now", "absent", "not-present");

        const released = (await env.events("1h")).filter(
          (entry) => entry.event === "lease.released",
        );
        expect(released.map((entry) => entry.payload)).toEqual([
          expect.objectContaining({ leaseId, reason: "device-lost" }),
        ]);

        await expectAfterPrompt(env, udid, "PLUG IN and UNLOCK the phone now", "ready");
      },
    );

    it(
      "while the iPhone streams, a person locking it ends the lease as device-lost and leaves no device capture running within 10 s",
      { timeout: 15 * MINUTE },
      async () => {
        const env = await startDaemon({ stream: true });
        await enroll(env, udid);
        await expectAfterPrompt(env, udid, "keep the phone unlocked and plugged in", "ready");
        const leased = await env.cli(
          ["lease", "--platform", "ios", "--physical", "--agent-id", "phone-lane-lock", "--detach"],
          { timeout: 2 * MINUTE },
        );
        expect(leased.code, `lease failed: ${leased.stderr}`).toBe(0);
        const leaseId = (leased.json as { lease: { id: string } }).lease.id;

        const created = await env.cli(["token", "create", "--role", "operator"]);
        expect(created.code, created.stderr).toBe(0);
        const viewer = new AbortController();
        const response = await fetch(
          `http://127.0.0.1:${String(env.port)}/v1/stream/leases/${encodeURIComponent(leaseId)}`,
          {
            headers: { authorization: `Bearer ${(created.json as { secret: string }).secret}` },
            signal: viewer.signal,
          },
        ).catch(() => undefined);
        expect(response?.status, "the leased iPhone did not start streaming").toBe(200);

        await expectAfterPrompt(env, udid, "LOCK the phone now", "absent", "locked");

        const released = (await env.events("1h"))
          .map((entry) => ({
            event: entry.event,
            payload: entry.payload as { leaseId?: string; reason?: string },
          }))
          .filter((entry) => entry.event === "lease.released" && entry.payload.leaseId === leaseId);
        expect(released.map((entry) => entry.payload.reason)).toContain("device-lost");
        await waitFor(async () => (await deviceCapturesRunning()) === 0, {
          interval: 500,
          label: "the device capture stopped once the locked iPhone's lease ended",
          timeout: 10_000,
        });
        viewer.abort();
      },
    );

    it("ends with device remove", { timeout: 5 * MINUTE }, async () => {
      const env = await startDaemon();
      await enroll(env, udid);

      const removed = await env.cli(["device", "remove", udid]);

      expect(removed.code, removed.stderr).toBe(0);
      // why: a removed device is absent, or kept as a "deleted" tombstone.
      expect(["deleted", undefined]).toContain((await deviceOf(env, udid))?.state);
    });
  },
);
