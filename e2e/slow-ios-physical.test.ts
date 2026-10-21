import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  SCREEN_TAGS as TAG,
  type TestEnv,
  readScreenFrames as readFrames,
  waitFor,
  waitForDeviceState,
  withHttpDaemon,
} from "./helpers/index.js";

const execFileAsync = promisify(execFile);

const UDID = process.env["SIMLOCK_PHYSICAL_IOS"];
const APP = process.env["SIMLOCK_PHYSICAL_IOS_APP"];

const DEVICE_PROGRAM = join(REPO_ROOT, "dist", "bin", "simlock-device-capture");
const SETTINGS_ARGS = [
  "--codec",
  "avcc",
  "--fps",
  "30",
  "--bitrate",
  "1500000",
  "--max-dimension",
  "720",
] as const;

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
  readonly deviceProperties?: { readonly osVersionNumber?: string };
  readonly properties?: { readonly software?: { readonly osVersionNumber?: string } };
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

/** why: CoreDevice streams an iPhone only from iOS 27, so which stream cases run depends on what the lane's iPhone runs. */
async function iosVersionOf(
  udid: string,
): Promise<{ readonly version: string; readonly major: number }> {
  const entry = await wiredEntry(udid);
  const version =
    entry.deviceProperties?.osVersionNumber ?? entry.properties?.software?.osVersionNumber;
  if (version === undefined) throw new Error(`devicectl gives no iOS version for ${udid}`);
  return { major: Number.parseInt(version, 10), version };
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
      capabilities: {
        stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
      },
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

    // why: the Physical iOS row of the toolchain requires CoreDevice 642 (Xcode 27), so a lane that
    // got this far has the toolchain the device program needs; a missing program is a broken build,
    // not a machine that cannot run the lane, and skipping it would hide that.
    it("the device capture program is built", { timeout: MINUTE }, () => {
      expect(
        existsSync(DEVICE_PROGRAM),
        `no ${DEVICE_PROGRAM} -- run pnpm build on a Mac with Xcode 27`,
      ).toBe(true);
    });

    it(
      "the device program refuses a Mac whose CoreDevice major is not 642, and names the version, the missing framework or the unreadable version as its reason",
      { timeout: 5 * MINUTE },
      async () => {
        const rows = [
          ["650.3", "this Mac has CoreDevice 650.3"],
          ["641.9", "this Mac has CoreDevice 641.9"],
          ["6420.1", "this Mac has CoreDevice 6420.1"],
          ["64.2", "this Mac has CoreDevice 64.2"],
          ["", "this Mac's CoreDevice version cannot be read"],
        ] as const;
        for (const [version, reason] of rows) {
          const plist = await aCoreDevicePlist(version);
          const run = await runDeviceProgram(plist, udid);
          expect(run.code, `CoreDevice ${version} is not 642: ${run.stderr}`).toBe(69);
          expect(lastLineOf(run.stderr)).toBe(
            `Physical iPhone streams need Xcode 27 (CoreDevice 642.x); ${reason}`,
          );
        }

        const absent = await runDeviceProgram(
          join(await mkdtemp(join(tmpdir(), "simlock-coredevice-")), "absent.plist"),
          udid,
        );
        expect(absent.code, "a Mac without CoreDevice cannot stream an iPhone").toBe(69);
        expect(lastLineOf(absent.stderr)).toBe(
          "Physical iPhone streams need Xcode 27 (CoreDevice 642.x); this Mac has no CoreDevice",
        );
      },
    );

    it(
      "the device program goes on for every CoreDevice 642.x spelling and, for a UDID it cannot find, exits 1 within 26 s naming it as not connected",
      { timeout: 10 * MINUTE },
      async () => {
        const unknown = "FFFFFFFF-0000-4000-8000-000000000000";
        for (const version of ["642.16", "642.0", "642", " 642.3 "]) {
          const plist = await aCoreDevicePlist(version);
          const started = Date.now();
          const run = await runDeviceProgram(plist, unknown);
          expect(
            run.code,
            `CoreDevice ${version} is 642.x, so the version is not what refused`,
          ).toBe(1);
          const elapsed = Date.now() - started;
          expect(
            elapsed,
            `CoreDevice ${version} found no device within the 25 s start bound`,
          ).toBeLessThan(26_000);
          expect(lastLineOf(run.stderr)).toContain(unknown);
          expect(lastLineOf(run.stderr)).toMatch(/not connected/iu);
        }
      },
    );

    it(
      "the device program asked to stop while it is still starting goes away inside the caller's grace, on its own and not by force",
      { timeout: 5 * MINUTE },
      async () => {
        // why: 642.x and a UDID that is not there leave the program in its 25 s start, which is when a
        // stop is hardest to honour — the caller SIGKILLs 2 s after it asks, and a program that cannot
        // leave a start it cannot cancel is SIGKILLed with the iPhone's media stream left up. Closing
        // stdin is the stop the driver uses; exit 0 within 2 s is that stop having been taken.
        const plist = await aCoreDevicePlist("642.0");
        const child = spawn(
          DEVICE_PROGRAM,
          ["FFFFFFFF-0000-4000-8000-000000000000", ...SETTINGS_ARGS],
          {
            env: { ...process.env, SIMLOCK_COREDEVICE_INFO_PLIST: plist },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        expect(child.exitCode, "the program ended before it was asked to").toBeNull();
        const askedAt = Date.now();
        child.stdin.end();
        const ended = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) => {
          child.once("exit", (exitCode, exitSignal) =>
            resolve({ code: exitCode, signal: exitSignal }),
          );
        });
        expect(
          Date.now() - askedAt,
          `the stop was not taken within 2 s, so the caller killed it: ${stderr}`,
        ).toBeLessThan(2_000);
        expect(
          ended.signal,
          `a stop the program was asked for is not a signal: ${stderr}`,
        ).toBeNull();
        expect(ended.code, "a stop the program was asked for is a clean end").toBe(0);
      },
    );

    it(
      "a lease on the iPhone streams its screen as meta with codec h264, an avcC description and a key frame; a still screen keeps the stream open past 35 s; a second viewer on the same lease either streams or refuses with a reason while the first keeps its frames; after the lease ends no device capture remains and a new lease streams a key frame",
      { timeout: 15 * MINUTE },
      async (context) => {
        // why: below iOS 27 CoreDevice refuses the stream; the refusal case below runs instead.
        if ((await iosVersionOf(udid)).major < 27) context.skip();
        expect(await deviceCapturesRunning(), "a device capture was already running").toBe(0);
        const daemon = await rig();
        await enroll(daemon.env, udid);
        const grant = await leasePhysical(daemon.env, "phone-lane-stream");
        const open = async (leaseId: string, signal: AbortSignal) => {
          const response = await fetch(
            `${daemon.base}/v1/stream/leases/${encodeURIComponent(leaseId)}`,
            { headers: daemon.auth, signal },
          );
          if (response.body === null) throw new Error("the stream answered without a body");
          // why: the reader is taken only for a 200; any other answer keeps its body unread so the
          // assertions below can still read it, and a 200's endless body is never read for a message.
          if (response.status !== 200) return { reader: null, response };
          return { reader: response.body.getReader(), response };
        };
        const reading = async (opened: Awaited<ReturnType<typeof open>>) => {
          expect(
            opened.response.status,
            opened.response.status === 200
              ? ""
              : await opened.response
                  .clone()
                  .text()
                  .catch(() => ""),
          ).toBe(200);
          return opened.reader!;
        };

        const viewer = new AbortController();
        const first = await open(grant.lease.id, viewer.signal);
        const firstReader = await reading(first);
        expect(first.response.headers.get("simlock-stream-codec")).toBe("h264");
        const frames = await readFrames(firstReader, (read) =>
          read.some((frame) => frame.tag === TAG.keyframe),
        );
        expect(frames.map((frame) => frame.tag).slice(0, 3)).toEqual([
          TAG.meta,
          TAG.description,
          TAG.keyframe,
        ]);
        const meta = JSON.parse(new TextDecoder().decode(frames[0]!.payload)) as {
          codec: string;
          width: number;
          height: number;
        };
        expect(meta.codec).toBe("h264");
        expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(720);
        expect(frames[1]!.payload[0]).toBe(1);
        expect(await deviceCapturesRunning()).toBe(1);

        // why: nothing touches the iPhone here, so its screen is still; the stream must stay open
        // well past the 30 s silence bound, on the source's own idle repaints.
        const stillUntil = Date.now() + 35_000;
        const held = await readFrames(firstReader, () => Date.now() > stillUntil);
        expect(held.length, "a still iPhone's stream sent nothing for 35 s").toBeGreaterThan(0);
        expect((await firstReader.read()).done, "a still iPhone's stream ended inside 35 s").toBe(
          false,
        );

        const second = await open(grant.lease.id, new AbortController().signal);
        if (second.response.status === 200) {
          await readFrames(second.reader!, (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
          );
        } else {
          expect(second.response.status).toBe(503);
          const refusal = (await second.response.json()) as { error?: { message?: string } };
          expect(refusal.error?.message, "a 503 says why").toBeTruthy();
        }
        // why: whatever the second viewer gets, the first must keep its own stream: read it for a
        // further 10 s and count what arrives.
        const alongsideUntil = Date.now() + 10_000;
        const alongside = await readFrames(firstReader, () => Date.now() > alongsideUntil);
        expect(alongside.length, "the first viewer received no frames for 10 s").toBeGreaterThan(0);

        const released = await daemon.env.cli(["release", grant.lease.id]);
        expect(released.code, released.stderr).toBe(0);
        await waitFor(async () => (await deviceCapturesRunning()) === 0, {
          interval: 250,
          label: "the device capture stopped once its lease ended",
          timeout: 5_000,
        });

        // why: the stream's own first-frame bound is 30 s, so a body that produced no key frame by
        // then has already failed or will not fail visibly; the race only names the claim.
        const again = await leasePhysical(daemon.env, "phone-lane-stream-2");
        const reopened = await open(again.lease.id, new AbortController().signal);
        const reopenedReader = await reading(reopened);
        const keyFrameArrived = await Promise.race([
          readFrames(reopenedReader, (read) =>
            read.some((frame) => frame.tag === TAG.keyframe),
          ).then((read) => read.some((frame) => frame.tag === TAG.keyframe)),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
        ]);
        expect(
          keyFrameArrived,
          "a new lease on the same iPhone streamed no key frame in 30 s",
        ).toBe(true);
        await daemon.env.cli(["release", again.lease.id]);
      },
    );

    it(
      "a lease on an iPhone below iOS 27 answers its stream 503 STREAM_UNAVAILABLE within 10 s, naming iOS 27 and the iPhone's version, and starts no device capture",
      { timeout: 5 * MINUTE },
      async (context) => {
        const { major, version } = await iosVersionOf(udid);
        if (major >= 27) context.skip();
        expect(await deviceCapturesRunning(), "a device capture was already running").toBe(0);
        const daemon = await rig();
        await enroll(daemon.env, udid);
        const grant = await leasePhysical(daemon.env, "phone-lane-old-ios");
        const asked = Date.now();
        const response = await fetch(
          `${daemon.base}/v1/stream/leases/${encodeURIComponent(grant.lease.id)}`,
          { headers: daemon.auth, signal: AbortSignal.timeout(10_000) },
        );
        // why: the status is read before any reader is taken; a 200's endless body is never read.
        const text = response.status === 200 ? "" : await response.text();
        expect(response.status, text).toBe(503);
        expect(Date.now() - asked, "the refusal took longer than 10 s").toBeLessThan(10_000);
        const refusal = JSON.parse(text) as { error?: { code?: string; message?: string } };
        expect(refusal.error?.code).toBe("STREAM_UNAVAILABLE");
        expect(refusal.error?.message).toContain("iOS 27");
        expect(refusal.error?.message).toContain(version);
        expect(await deviceCapturesRunning(), "a device capture was started").toBe(0);
        await daemon.env.cli(["release", grant.lease.id]);
      },
    );
  },
);

/** why: `pgrep -x` matches the program's own name only; a pattern match would also find the shell running this check (F44). */
async function deviceCapturesRunning(): Promise<number> {
  const found = await execFileAsync("pgrep", ["-x", "simlock-device-capture"]).catch(() => ({
    stdout: "",
  }));
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

// why: the program reads its version from SIMLOCK_COREDEVICE_INFO_PLIST only in tests (the driver
// never passes it), and `version` of "" plants a plist without the key -- the row the program is
// required to read as "this Mac's CoreDevice version cannot be read" rather than as an empty 642.
async function aCoreDevicePlist(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "simlock-coredevice-"));
  const path = join(dir, "Info.plist");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    ...(version === ""
      ? []
      : [`  <key>CFBundleShortVersionString</key><string>${version}</string>`]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  await writeFile(path, body, "utf8");
  return path;
}

// why: runs the device program on its own, with a version file the driver never passes. `device` is
// the UDID it is asked to stream; the caller's 26 s bound is the program's own 25 s start deadline.
// `stdio[0]` is `pipe` and not `ignore` because stdin is the capture's liveness handle: the
// driver hands it a live pipe it closes only to stop, and a pipe hung up at birth is a stop asked for
// before the program began, which the program answers by exiting 0 without ever looking for a device.
async function runDeviceProgram(
  infoPlist: string,
  device: string,
): Promise<{ code: number; stderr: string }> {
  const child = spawn(DEVICE_PROGRAM, [device, ...SETTINGS_ARGS], {
    env: { ...process.env, SIMLOCK_COREDEVICE_INFO_PLIST: infoPlist },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? -1));
  });
  return { code, stderr };
}

function lastLineOf(text: string): string {
  return text.trimEnd().split("\n").at(-1) ?? "";
}
