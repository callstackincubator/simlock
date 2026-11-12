import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  REPO_ROOT,
  SCREEN_TAGS,
  deviceStreamUrl,
  freeLoopbackPort,
  readScreenFrames,
  waitFor,
  withSharedDaemon,
} from "./helpers/index.js";
import type { ScreenFrame } from "./helpers/screen-frames.js";
import type { SharedTestEnv as TestEnv } from "./helpers/env.js";

const execFileAsync = promisify(execFile);

const AGENT_DEVICE = process.env.SIMLOCK_E2E_AGENT_DEVICE;
const DUO_MODEL = "iPhone Duo";
const MIN_RUNTIME = [27, 1] as const;
const UNFRAME = join(REPO_ROOT, "vendor", "screen-capture", "scripts", "unframe.mjs");
const SWITCH_BOUND_MS = 5_000;
const STREAM_BOUND_MS = 240_000;
const FOLD_SESSION = "simlock-foldable-e2e";
// why: a decoded picture counts as lit when its mean luminance is above 2% of white, the same line
// the capture's own panel read uses; a black panel reads 0.
const LIT_ABOVE = 0.02;
const COMPARE_WIDTH = 64;
const COMPARE_HEIGHT = 45;
const SAME_PICTURE_BELOW = 0.1;

async function has(command: string, args: string[]): Promise<boolean> {
  return execFileAsync(command, args).then(
    () => true,
    () => false,
  );
}

function atLeast(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_RUNTIME[0] || (major === MIN_RUNTIME[0] && minor >= MIN_RUNTIME[1]);
}

// why: the slow lane has no fold of its own; without agent-device, an iPhone Duo device type, an
// iOS 27.1 runtime or ffmpeg the file cannot prove anything, and says which one is missing.
async function whyNotRunnable(): Promise<string | undefined> {
  if (process.platform !== "darwin") return "not macOS";
  if (AGENT_DEVICE === undefined) return "SIMLOCK_E2E_AGENT_DEVICE is not set";
  if (!(await has("ffmpeg", ["-version"]))) return "ffmpeg is not installed";
  const types = await execFileAsync("xcrun", ["simctl", "list", "devicetypes"]).catch(() => ({
    stdout: "",
  }));
  if (!types.stdout.includes(DUO_MODEL)) return "no iPhone Duo device type";
  const runtimes = await execFileAsync("xcrun", ["simctl", "list", "runtimes"]).catch(() => ({
    stdout: "",
  }));
  const found = [...runtimes.stdout.matchAll(/^iOS (\d+(?:\.\d+)?) /gm)].some((match) =>
    atLeast(match[1]!),
  );
  return found ? undefined : "no iOS 27.1 or later runtime";
}

const notRunnable = await whyNotRunnable();
if (notRunnable !== undefined) console.warn(`slow-ios-foldable skipped: ${notRunnable}`);

async function within<T>(work: Promise<T>, bound: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${String(bound)} ms waiting for ${what}`)),
      bound,
    );
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

interface Meta {
  readonly width: number;
  readonly height: number;
}

function metaOf(frame: ScreenFrame): Meta {
  return JSON.parse(new TextDecoder().decode(frame.payload)) as Meta;
}

// why: a stream with a size change is several decodable parts, one per meta frame; ffmpeg given the
// whole thing would scale every part to the first one's size and hide the very change under test.
function partsOf(frames: readonly ScreenFrame[]): ScreenFrame[][] {
  const parts: ScreenFrame[][] = [];
  for (const frame of frames) {
    if (frame.tag === SCREEN_TAGS.meta) parts.push([]);
    parts.at(-1)?.push(frame);
  }
  return parts;
}

function envelope(frames: readonly ScreenFrame[]): Buffer {
  return Buffer.concat(
    frames.map((frame) => {
      const head = Buffer.alloc(5);
      head.writeUInt32BE(frame.payload.length + 1, 0);
      head[4] = frame.tag;
      return Buffer.concat([head, frame.payload]);
    }),
  );
}

async function decodeLast(
  part: readonly ScreenFrame[],
  dir: string,
  name: string,
): Promise<Buffer> {
  const raw = join(dir, `${name}.bin`);
  const annexB = join(dir, `${name}.264`);
  await writeFile(raw, envelope(part));
  await execFileAsync("node", [UNFRAME, raw, annexB]);
  const decoded = await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      annexB,
      "-vf",
      `scale=${String(COMPARE_WIDTH)}:${String(COMPARE_HEIGHT)},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const size = COMPARE_WIDTH * COMPARE_HEIGHT;
  expect(decoded.stdout.length, `${name} did not decode a picture`).toBeGreaterThanOrEqual(size);
  return decoded.stdout.subarray(decoded.stdout.length - size);
}

function meanOf(gray: Buffer): number {
  return gray.reduce((sum, value) => sum + value, 0) / gray.length / 255;
}

async function screenshotGray(
  deviceSet: string,
  udid: string,
  display: number,
  dir: string,
): Promise<Buffer> {
  const png = join(dir, `screenshot-${String(display)}.png`);
  await execFileAsync("xcrun", [
    "simctl",
    "--set",
    deviceSet,
    "io",
    udid,
    "screenshot",
    "--type=png",
    `--display=${String(display)}`,
    png,
  ]);
  const decoded = await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      png,
      "-vf",
      `scale=${String(COMPARE_WIDTH)}:${String(COMPARE_HEIGHT)},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return decoded.stdout;
}

function meanAbsoluteDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += Math.abs(left[index]! - right[index]!);
  return total / left.length / 255;
}

async function pidsOf(args: string[]): Promise<number[]> {
  const found = await execFileAsync("pgrep", args).catch(() => ({ stdout: "" }));
  return found.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number);
}

// why: `pgrep -x` matches the program's own name only; a pattern match would also find the shell
// running this check.
const capturePids = () => pidsOf(["-x", "simlock-screen-capture"]);

// why: the follower's children are `simctl spawn <udid> log stream|show` under a watchdog; matching
// the udid keeps another simulator's log out of the count.
const logChildren = (udid: string) => pidsOf(["-f", `simctl .*spawn ${udid} log (stream|show)`]);

// why: the simulator's runtimes ship no `ps`; its processes are host processes whose parent is the
// simulator's `launchd_sim`, whose arguments name the udid, so the in-simulator `log stream` is that
// launchd's child.
async function simulatorLogStreams(udid: string): Promise<number> {
  const launchds = await pidsOf(["-f", `^launchd_sim .*/${udid}/`]);
  const streams = await Promise.all(
    launchds.map((pid) => pidsOf(["-P", String(pid), "-f", "^log stream"])),
  );
  return streams.flat().length;
}

interface Lease {
  readonly id: string;
  readonly deviceId: string;
  readonly udid: string;
  readonly deviceSet: string;
}

async function duoOs(env: TestEnv): Promise<string> {
  const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
  expect(catalog.code, `catalog failed: ${catalog.stderr}`).toBe(0);
  const platforms = (
    catalog.json as {
      platforms: { platform: string; modelRuntimes: Record<string, string[]> }[];
    }
  ).platforms;
  const runtimes = platforms.find((p) => p.platform === "ios")?.modelRuntimes[DUO_MODEL] ?? [];
  const os = runtimes
    .filter(atLeast)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  expect(os, "the catalog pairs no iPhone Duo with an iOS 27.1 or later runtime").toBeDefined();
  return os!;
}

describe.skipIf(notRunnable !== undefined)(
  "iOS foldable simulator stream (real simulator)",
  { tags: ["slow", "ios"] },
  () => {
    let dir: string | undefined;
    let teardown: (() => Promise<void>) | undefined;
    let started:
      | Promise<{ env: TestEnv; baseUrl: string; authorization: string; lease: Lease }>
      | undefined;

    // why: one lease serves every case, because leasing and booting a Duo is most of a case's time.
    function setup() {
      started ??= (async () => {
        dir = await mkdtemp(join(tmpdir(), "simlock-foldable-"));
        const port = await freeLoopbackPort();
        // why: the shared daemon belongs to the file, not to the first test: `withDaemon`'s env is
        // torn down after the test that made it, which would leave the second test a stopped
        // daemon, and the file's own `nuke` would start a new one that nothing stops.
        const env = await withSharedDaemon({
          configOverrides: {
            http: { enabled: true, host: "127.0.0.1", port },
            // why: the file leases one Duo; a second one booting in the warm pool beside it is load
            // on agent-device's 3 s reads of the leased one, and proves nothing.
            warmPool: { enabled: false },
            capabilities: {
              stream: { bitrateKbps: 1500, enabled: true, fps: 30, maxDimension: 720 },
            },
          },
          driver: "real",
        });
        teardown = async () => {
          try {
            await env
              .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
              .catch(() => undefined);
          } finally {
            await env.teardown();
          }
        };
        const granted = await env.cli(
          [
            "lease",
            "--platform",
            "ios",
            "--device",
            DUO_MODEL,
            "--os",
            await duoOs(env),
            "--agent-id",
            "ios-foldable",
            "--detach",
          ],
          { timeout: DEVICE_READY_MS },
        );
        expect(granted.code, `lease failed: ${granted.stdout} ${granted.stderr}`).toBe(0);
        const grant = granted.json as {
          device: { id: string; driverDeviceId: string };
          environment: Record<string, string>;
          lease: { id: string };
        };
        const lease: Lease = {
          deviceId: grant.device.id,
          deviceSet: grant.environment.SIMLOCK_IOS_DEVICE_SET as string,
          id: grant.lease.id,
          udid: grant.device.driverDeviceId,
        };
        const created = await env.cli(["token", "create", "--role", "operator"]);
        expect(created.code, created.stderr).toBe(0);
        const authorization = `Bearer ${(created.json as { secret: string }).secret}`;
        // why: agent-device finds the simulator in Simlock's own set through its scoped-set flag;
        // a session on the lease's UDID is what `fold` needs.
        await execFileAsync("node", [
          AGENT_DEVICE!,
          "open",
          "com.apple.Preferences",
          "--platform",
          "ios",
          "--udid",
          lease.udid,
          "--ios-simulator-device-set",
          lease.deviceSet,
          "--session",
          FOLD_SESSION,
        ]);
        return { authorization, baseUrl: `http://127.0.0.1:${String(port)}`, env, lease };
      })();
      return started;
    }

    afterAll(async () => {
      if (started !== undefined) {
        await execFileAsync("node", [AGENT_DEVICE!, "close", "--session", FOLD_SESSION]).catch(
          () => undefined,
        );
      }
      await teardown?.();
      if (dir !== undefined) await rm(dir, { force: true, recursive: true });
    }, 180_000);

    // why: agent-device reads the hinge and the panel table back to confirm a pose, each under a
    // 3 s limit of its own; a simulator just booted on a loaded host misses it though the pose was
    // sent, and sending it again is harmless. The failure is the test's when the retries end.
    const UNCONFIRMED = /no panel table|no hinge-angle sample|returned no sample/;
    const FOLD_ATTEMPTS = 3;

    // why: the 5 s bound is about the stream following the fold, not about how long agent-device
    // takes to reach the simulator, which is seconds on a loaded host; agent-device logs the time
    // it sent the pose, and that is where the bound is counted from.
    async function poseSentAt(since: number): Promise<number | undefined> {
      const requests = join(homedir(), ".agent-device", "sessions", FOLD_SESSION, "requests");
      const sent: number[] = [];
      for (const name of await readdir(requests).catch(() => [] as string[])) {
        const text = await readFile(join(requests, name), "utf8").catch(() => "");
        for (const line of text.split("\n")) {
          if (!line.includes('"apple_fold_pose_dispatched"')) continue;
          const at = Date.parse((JSON.parse(line) as { ts: string }).ts);
          if (at >= since) sent.push(at);
        }
      }
      return sent.length === 0 ? undefined : Math.min(...sent);
    }

    async function fold(pose: "open" | "closed"): Promise<number> {
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          await execFileAsync("node", [AGENT_DEVICE!, "fold", pose, "--session", FOLD_SESSION], {
            timeout: 60_000,
          });
          return (await poseSentAt(started)) ?? started;
        } catch (error: unknown) {
          const failed = error as { stderr?: string; stdout?: string; message: string };
          const message = failed.stderr ?? failed.message;
          if (attempt < FOLD_ATTEMPTS && UNCONFIRMED.test(message)) continue;
          // why: its own failure is the test's failure, with its message (I10).
          throw new Error(`agent-device fold ${pose} failed: ${message}`);
        }
      }
    }

    async function open(signal: AbortSignal) {
      const { authorization, baseUrl, env, lease } = await setup();
      const response = await within(
        fetch(await deviceStreamUrl(baseUrl, env.home, lease.deviceId), {
          headers: { authorization },
          signal,
        }),
        STREAM_BOUND_MS,
        "the stream to open",
      );
      const detail = response.status === 200 ? "" : await response.text().catch(() => "");
      expect(response.status, detail).toBe(200);
      if (response.body === null) throw new Error("the stream answered without a body");
      return response.body.getReader();
    }

    it(
      "a viewer of a leased Duo sees the cover folded and the inner panel unfolded, upright and lit, and the stream switches within 5 s of each fold",
      { timeout: 900_000 },
      async () => {
        const { lease } = await setup();
        const work = dir!;
        await fold("closed");

        const folded = new AbortController();
        const reader = await open(folded.signal);
        const switches: { at: number; count: number }[] = [];
        let settled = false;
        const frames: ScreenFrame[] = [];
        const reading = readScreenFrames(reader, (read) => {
          frames.length = 0;
          frames.push(...read);
          const metas = read.filter((frame) => frame.tag === SCREEN_TAGS.meta).length;
          if (metas > (switches.at(-1)?.count ?? 0))
            switches.push({ at: Date.now(), count: metas });
          const last = partsOf(read).at(-1) ?? [];
          const pictures = last.filter(
            (frame) => frame.tag === SCREEN_TAGS.keyframe || frame.tag === 0x03,
          );
          return metas >= 3 && pictures.length >= 3 && settled;
        });
        // why: a failing test ends the daemon, which cuts the stream; that rejection must not
        // surface as an unhandled one.
        reading.catch(() => undefined);
        const metaCount = () => switches.at(-1)?.count ?? 0;
        await waitFor(() => metaCount() >= 1 && frames.length >= 3, {
          interval: 250,
          label: "the folded stream's first pictures",
          timeout: 120_000,
        });
        const opening = partsOf(frames)[0]!;
        expect(metaOf(opening[0]!)).toMatchObject({ height: 720, width: 494 });
        expect(
          meanOf(await decodeLast(opening, work, "folded")),
          "the folded cover is black",
        ).toBeGreaterThan(LIT_ABOVE);

        for (const [pose, count] of [
          ["open", 2],
          ["closed", 3],
        ] as const) {
          const foldedAt = await fold(pose);
          await waitFor(() => metaCount() >= count, {
            interval: 100,
            label: `the meta frame after folding ${pose}`,
            timeout: 30_000,
          });
          const switched = switches.find((entry) => entry.count === count)!.at - foldedAt;
          expect(switched, `the switch after folding ${pose} took too long`).toBeLessThan(
            SWITCH_BOUND_MS,
          );
        }
        // why: the log names the panel before SpringBoard has painted it, so the first pictures
        // after a switch can be black on a loaded host; the claim is that the panel is lit once it
        // has been painted, which the last picture shows.
        const litBy = Date.now() + 60_000;
        for (;;) {
          const last = partsOf(frames).at(-1) ?? [];
          if (last.some((frame) => frame.tag === SCREEN_TAGS.keyframe || frame.tag === 0x03)) {
            const gray = await decodeLast(last, work, "settle");
            if (meanOf(gray) > LIT_ABOVE) break;
          }
          if (Date.now() > litBy) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        settled = true;
        const all = await within(reading, 60_000, "the pictures after the last switch");
        folded.abort();
        const parts = partsOf(all);
        expect(parts.map((part) => metaOf(part[0]!))).toMatchObject([
          { height: 720, width: 494 },
          { height: 506, width: 720 },
          { height: 720, width: 494 },
        ]);
        for (const [index, part] of parts.entries()) {
          expect(
            meanOf(await decodeLast(part, work, `part-${String(index)}`)),
            `part ${String(index)} is black`,
          ).toBeGreaterThan(LIT_ABOVE);
        }

        await fold("open");
        const unfolded = new AbortController();
        const inner = await open(unfolded.signal);
        const pictures = await within(
          readScreenFrames(inner, (read) => {
            const last = partsOf(read).at(-1) ?? [];
            return last.filter((frame) => frame.tag === 0x03).length >= 3;
          }),
          STREAM_BOUND_MS,
          "the unfolded stream's pictures",
        );
        unfolded.abort();
        const first = partsOf(pictures)[0]!;
        expect(metaOf(first[0]!)).toMatchObject({ height: 506, width: 720 });
        const seen = await decodeLast(first, work, "unfolded");
        expect(meanOf(seen), "the unfolded inner panel is black").toBeGreaterThan(LIT_ABOVE);
        const shot = await screenshotGray(lease.deviceSet, lease.udid, 3, work);
        expect(
          meanAbsoluteDifference(seen, shot),
          "the stream's inner picture is not the screenshot of the inner panel",
        ).toBeLessThan(SAME_PICTURE_BELOW);
      },
    );

    it(
      "the capture's log children end within 5 s of its stdin closing, a SIGTERM and a SIGKILL",
      { timeout: 600_000 },
      async () => {
        const { lease } = await setup();
        for (const how of ["stdin closed", "SIGTERM", "SIGKILL"] as const) {
          const viewer = new AbortController();
          const reader = await open(viewer.signal);
          await within(
            readScreenFrames(reader, (read) =>
              read.some((frame) => frame.tag === SCREEN_TAGS.keyframe),
            ),
            STREAM_BOUND_MS,
            `${how}: the stream's key frame`,
          );
          await waitFor(async () => (await logChildren(lease.udid)).length > 0, {
            interval: 250,
            label: `${how}: the capture started its log children`,
            timeout: 30_000,
          });
          await waitFor(async () => (await simulatorLogStreams(lease.udid)) > 0, {
            interval: 250,
            label: `${how}: the simulator runs the capture's log stream`,
            timeout: 30_000,
          });
          const [capture] = await capturePids();
          expect(capture, `${how}: no capture is running`).toBeDefined();
          if (how === "stdin closed") viewer.abort();
          else process.kill(capture!, how);
          await waitFor(async () => (await logChildren(lease.udid)).length === 0, {
            interval: 250,
            label: `${how}: the log children of the ended capture`,
            timeout: 5_000,
          });
          await waitFor(async () => (await simulatorLogStreams(lease.udid)) === 0, {
            interval: 250,
            label: `${how}: the log stream inside the simulator of the ended capture`,
            timeout: 5_000,
          });
          viewer.abort();
          await waitFor(async () => (await capturePids()).length === 0, {
            interval: 250,
            label: `${how}: the capture to be gone`,
            timeout: 15_000,
          });
        }
      },
    );
  },
);
