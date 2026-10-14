import { execFile } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { type TestEnv, waitFor, waitForDeviceState, withHttpDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const UDID = process.env["SIMLOCK_PHYSICAL_IOS"];
const APP = process.env["SIMLOCK_PHYSICAL_IOS_APP"];

const PROBE_INTERVAL_MS = 2_000;
const MINUTE = 60_000;

const missing =
  UDID === undefined || UDID === ""
    ? "SIMLOCK_PHYSICAL_IOS"
    : APP === undefined || APP === ""
      ? "SIMLOCK_PHYSICAL_IOS_APP"
      : undefined;

interface Grant {
  readonly device: { readonly driverDeviceId: string };
  readonly environment: Record<string, string>;
  readonly lease: { readonly id: string };
}

interface ListedDevice {
  readonly identifier: string;
  readonly hardwareProperties?: { readonly udid?: string };
  readonly connectionProperties?: {
    readonly transportType?: string;
    readonly tunnelState?: string;
  };
}

interface Rig {
  readonly env: TestEnv;
  readonly base: string;
  readonly auth: Record<string, string>;
}

async function devicectlJson(args: readonly string[]): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "simlock-physical-"));
  const file = join(dir, "out.json");
  await execFileAsync("xcrun", ["devicectl", ...args, "--json-output", file], {
    timeout: MINUTE,
  });
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function listedDevices(): Promise<ListedDevice[]> {
  const parsed = (await devicectlJson(["list", "devices"])) as {
    result: { devices: ListedDevice[] };
  };
  return parsed.result.devices;
}

async function wiredEntry(udid: string): Promise<ListedDevice> {
  const entry = (await listedDevices()).find(
    (device) =>
      device.hardwareProperties?.udid === udid &&
      device.connectionProperties?.transportType === "wired",
  );
  if (entry === undefined) throw new Error(`devicectl lists no wired device with UDID ${udid}`);
  return entry;
}

async function installedBundles(udid: string): Promise<string[]> {
  const parsed = (await devicectlJson(["device", "info", "apps", "--device", udid])) as {
    result: { apps: { bundleIdentifier: string }[] };
  };
  return parsed.result.apps.map((app) => app.bundleIdentifier);
}

async function bundleIdOf(app: string): Promise<string> {
  const { stdout } = await execFileAsync("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    join(app, "Info.plist"),
  ]);
  return stdout.trim();
}

/** why: a previous run or test may have left the test app on the phone, which would void the install claims. */
async function uninstallDirect(udid: string, bundle: string): Promise<void> {
  if ((await installedBundles(udid)).includes(bundle)) {
    await execFileAsync(
      "xcrun",
      ["devicectl", "device", "uninstall", "app", "--device", udid, bundle],
      { timeout: MINUTE },
    );
  }
}

async function rig(): Promise<Rig> {
  const { env, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      health: { probeIntervalMs: PROBE_INTERVAL_MS, stableObservations: 2 },
      http: { enabled: true, host: "127.0.0.1", port },
    },
    driver: "real",
  }));
  const base = `http://127.0.0.1:${String(port)}`;
  await waitFor(
    async () => {
      try {
        return (await fetch(`${base}/v1/healthz`)).ok;
      } catch {
        return false;
      }
    },
    { label: "HTTP API accepting connections" },
  );
  const created = await env.cli(["token", "create", "--role", "operator"]);
  expect(created.code, created.stderr).toBe(0);
  const auth = {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
  return { auth, base, env };
}

async function enroll(env: TestEnv, id: string): Promise<void> {
  const added = await env.cli(["device", "add", "--platform", "ios", id, "--json"], {
    timeout: 2 * MINUTE,
  });
  expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
}

async function leasePhysical(env: TestEnv, agent: string): Promise<Grant> {
  const leased = await env.cli(
    ["lease", "--platform", "ios", "--physical", "--agent-id", agent, "--detach"],
    { timeout: 2 * MINUTE },
  );
  expect(leased.code, `lease failed: ${leased.stderr}`).toBe(0);
  return leased.json as Grant;
}

async function exec(
  daemon: Rig,
  leaseId: string,
  agent: string,
  args: readonly string[],
): Promise<Response> {
  return fetch(`${daemon.base}/v1/leases/${leaseId}/exec`, {
    body: JSON.stringify({ args, requesterId: agent, tool: "devicectl" }),
    headers: daemon.auth,
    method: "POST",
  });
}

async function exitCodeOf(response: Response): Promise<{ code: number; body: string }> {
  expect(response.status).toBe(200);
  const body = await response.text();
  const frames = body.split("\n\n").filter((raw) => raw.includes("event: exit"));
  const data = /data:\s*(\{.*\})/.exec(frames.at(-1) ?? "")?.[1];
  if (data === undefined) throw new Error(`no exit frame in the exec stream: ${body}`);
  return { body, code: (JSON.parse(data) as { exitCode: number }).exitCode };
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe.skipIf(process.platform !== "darwin" || missing !== undefined)(
  missing === undefined
    ? "iOS physical phone (real devicectl)"
    : `iOS physical phone (skipped: ${missing} is not set)`,
  { tags: ["slow", "ios", "physical"] },
  () => {
    const udid = UDID as string;
    const app = APP as string;

    it(
      "enrolling by the phone's CoreDevice ID shows the device in list --devices under its UDID, marked physical",
      { timeout: 5 * MINUTE },
      async () => {
        const { env } = await rig();
        const coreDeviceId = (await wiredEntry(udid)).identifier;

        await enroll(env, coreDeviceId);

        const rows = (await env.cli(["list", "--devices"])).json as {
          driverDeviceId: string;
          physical: boolean;
        }[];
        const row = rows.find((candidate) => candidate.driverDeviceId === udid);
        expect(row, `no enrolled device under UDID ${udid}`).toBeDefined();
        expect(row?.physical).toBe(true);
      },
    );

    it(
      "the plugged-in, unlocked phone reads present: it stays ready across three probe intervals",
      { timeout: 5 * MINUTE },
      async () => {
        const { env } = await rig();
        const entry = await wiredEntry(udid);
        console.info(
          `phone lane: tunnelState of ${udid} is ${String(entry.connectionProperties?.tunnelState)}`,
        );
        await enroll(env, udid);
        await waitForDeviceState(env, udid, "ready");

        const seen: string[] = [];
        const until = Date.now() + 3 * PROBE_INTERVAL_MS + 1_000;
        await waitFor(
          async () => {
            const rows = (await env.cli(["list", "--devices"])).json as {
              driverDeviceId: string;
              state: string;
            }[];
            seen.push(rows.find((row) => row.driverDeviceId === udid)?.state ?? "missing");
            return Date.now() >= until;
          },
          { interval: 500, label: "three probe intervals observed", timeout: MINUTE },
        );

        expect(new Set(seen)).toEqual(new Set(["ready"]));
      },
    );

    it(
      "an app installed before enrollment is still installed after a lease and release",
      { timeout: 10 * MINUTE },
      async () => {
        const bundle = await bundleIdOf(app);
        await uninstallDirect(udid, bundle);
        await execFileAsync(
          "xcrun",
          ["devicectl", "device", "install", "app", "--device", udid, app],
          { timeout: 5 * MINUTE },
        );
        try {
          const { env } = await rig();
          await enroll(env, udid);
          const grant = await leasePhysical(env, "phone-lane-keep");
          const released = await env.cli(["release", grant.lease.id]);
          expect(released.code, released.stderr).toBe(0);
          await waitForDeviceState(env, udid, "ready", { timeout: 2 * MINUTE });

          expect(await installedBundles(udid)).toContain(bundle);
        } finally {
          await uninstallDirect(udid, bundle);
        }
      },
    );

    it(
      "after re-enrolling without that app, an install through device.exec devicectl device install app (no --device) exits 0, and after release the app is gone and the device is ready",
      { timeout: 10 * MINUTE },
      async () => {
        const bundle = await bundleIdOf(app);
        await uninstallDirect(udid, bundle);
        const daemon = await rig();
        await enroll(daemon.env, udid);
        const grant = await leasePhysical(daemon.env, "phone-lane-install");

        const installed = await exitCodeOf(
          await exec(daemon, grant.lease.id, "phone-lane-install", [
            "device",
            "install",
            "app",
            app,
          ]),
        );
        expect(installed.code, installed.body).toBe(0);
        expect(await installedBundles(udid)).toContain(bundle);

        const released = await daemon.env.cli(["release", grant.lease.id]);
        expect(released.code, released.stderr).toBe(0);
        await waitForDeviceState(daemon.env, udid, "ready", { timeout: 3 * MINUTE });
        expect(await installedBundles(udid)).not.toContain(bundle);
      },
    );

    it(
      "device.exec devicectl --json-output <path> list devices is refused and no file appears at <path>",
      { timeout: 5 * MINUTE },
      async () => {
        const daemon = await rig();
        await enroll(daemon.env, udid);
        const grant = await leasePhysical(daemon.env, "phone-lane-refuse");
        const target = join(await mkdtemp(join(tmpdir(), "simlock-physical-")), "refused.json");

        const refused = await exec(daemon, grant.lease.id, "phone-lane-refuse", [
          "--json-output",
          target,
          "list",
          "devices",
        ]);

        expect(refused.status).toBe(422);
        expect(await errorCodeOf(refused)).toBe("PASSTHROUGH_REFUSED");
        await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
        await daemon.env.cli(["release", grant.lease.id]);
      },
    );

    it(
      "device.exec devicectl device process launch <bundle> -- -AppleLanguages (en) of the test app exits 0",
      { timeout: 10 * MINUTE },
      async () => {
        const bundle = await bundleIdOf(app);
        await uninstallDirect(udid, bundle);
        const daemon = await rig();
        await enroll(daemon.env, udid);
        const grant = await leasePhysical(daemon.env, "phone-lane-launch");
        const installed = await exitCodeOf(
          await exec(daemon, grant.lease.id, "phone-lane-launch", [
            "device",
            "install",
            "app",
            app,
          ]),
        );
        expect(installed.code, installed.body).toBe(0);

        const launched = await exitCodeOf(
          await exec(daemon, grant.lease.id, "phone-lane-launch", [
            "device",
            "process",
            "launch",
            bundle,
            "--",
            "-AppleLanguages",
            "(en)",
          ]),
        );

        expect(launched.code, launched.body).toBe(0);
        await daemon.env.cli(["release", grant.lease.id]);
        await waitForDeviceState(daemon.env, udid, "ready", { timeout: 3 * MINUTE });
      },
    );

    it(
      "the grant's environment carries SIMLOCK_DEVICE_UDID equal to the phone's UDID",
      { timeout: 5 * MINUTE },
      async () => {
        const { env } = await rig();
        await enroll(env, udid);

        const grant = await leasePhysical(env, "phone-lane-env");

        expect(grant.environment["SIMLOCK_DEVICE_UDID"]).toBe(udid);
        await env.cli(["release", grant.lease.id]);
      },
    );

    it("ends with device remove, and removes the test app", { timeout: 5 * MINUTE }, async () => {
      const bundle = await bundleIdOf(app);
      const { env } = await rig();
      await enroll(env, udid);

      const removed = await env.cli(["device", "remove", udid]);
      expect(removed.code, removed.stderr).toBe(0);
      const rows = (await env.cli(["list", "--devices"])).json as {
        driverDeviceId: string;
        state: string;
      }[];
      expect(rows.filter((row) => row.driverDeviceId === udid && row.state !== "deleted")).toEqual(
        [],
      );

      await uninstallDirect(udid, bundle);
      expect(await installedBundles(udid)).not.toContain(bundle);
    });
  },
);
