// why: whether a simulator stream shows each app frame once and evenly can only be told by an app
// that stamps every frame it draws, so this builds the counter app, runs the capture against it and
// decodes the stamp back out of the stream. A hand-run measurement, not a lane test.
//
//   node scripts/fps-reader.mjs --udid <UDID> --scenario scroll|animation --bin <simlock-screen-capture> [--seconds 20]
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ID = "dev.simlock.fpscounter";

const { udid, scenario, bin, seconds } = parseArguments(process.argv.slice(2));

if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error) {
  console.error("ffmpeg not found");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "fps-reader-"));
try {
  const app = buildApp(work);
  run("xcrun", ["simctl", "install", udid, app]);
  run("xcrun", ["simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID, scenario]);
  const capture = await runCapture(join(work, "capture.bin"));
  run("node", [join(here, "unframe.mjs"), join(work, "capture.bin"), join(work, "capture.264")]);
  const counts = decodeCounts(join(work, "capture.264"));
  report(counts, capture);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function parseArguments(args) {
  const values = { seconds: "20" };
  for (let i = 0; i < args.length; i += 2) values[args[i].replace(/^--/, "")] = args[i + 1];
  const { udid, scenario, bin, seconds } = values;
  const valid = [udid, bin, ["scroll", "animation"].find((name) => name === scenario)];
  if (valid.some((value) => !value)) usage();
  return { udid, scenario, bin, seconds: Number(seconds) };
}

function usage() {
  console.error(
    "usage: node scripts/fps-reader.mjs --udid <UDID> --scenario scroll|animation --bin <path> [--seconds 20]",
  );
  process.exit(64);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

function buildApp(directory) {
  run("xcodebuild", [
    "-project",
    join(here, "fps-counter", "FpsCounter.xcodeproj"),
    "-scheme",
    "FpsCounter",
    "-sdk",
    "iphonesimulator",
    "-configuration",
    "Release",
    "-derivedDataPath",
    join(directory, "build"),
    "build",
  ]);
  return join(directory, "build", "Build", "Products", "Release-iphonesimulator", "FpsCounter.app");
}

/** why: the envelope is a 4-byte length (counting the tag byte) and a tag; tags 2 and 3 are frames. Returns the first whole envelope of `buffer`, or null when it holds none yet. */
function takeEnvelope(buffer) {
  if (buffer.length < 5 || buffer.length < 4 + buffer.readUInt32BE(0)) return null;
  return {
    isFrame: buffer[4] === 2 || buffer[4] === 3,
    rest: buffer.subarray(4 + buffer.readUInt32BE(0)),
  };
}

/** why: the frame arrival times and CPU samples come from one run of the capture. Runs it for `seconds`, keeps its framed output in `file`, and returns the arrival time (ms) of each video frame and the program's CPU samples. */
function runCapture(file) {
  return new Promise((resolve) => {
    const child = spawn(bin, [udid, "--fps", "60"], { stdio: ["pipe", "pipe", "ignore"] });
    // why: the capture stops when its stdin closes, so the pipe is held open until the run ends.
    const chunks = [];
    const arrivals = [];
    let pending = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      const now = performance.now();
      chunks.push(chunk);
      pending = Buffer.concat([pending, chunk]);
      for (let next = takeEnvelope(pending); next; next = takeEnvelope(pending)) {
        if (next.isFrame) arrivals.push(now);
        pending = next.rest;
      }
    });
    const cpu = [];
    const sampler = setInterval(() => {
      const out = spawnSync("ps", ["-o", "%cpu=", "-p", String(child.pid)], {
        encoding: "utf8",
      }).stdout.trim();
      if (out) cpu.push(Number(out));
    }, 1000);
    child.on("close", () => {
      clearInterval(sampler);
      writeFileSync(file, Buffer.concat(chunks));
      resolve({ arrivals, cpu });
    });
    setTimeout(() => child.kill("SIGTERM"), seconds * 1000);
  });
}

/**
 * why: the counter's pixels are the only stamp a frame carries. Decodes every frame of the stream and reads the counter row: the screen's band under the safe
 * area of an iPhone 17 Pro, averaged to 16 pixels, one per block, white above half grey.
 */
function decodeCounts(file) {
  const raw = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "h264",
      "-i",
      file,
      "-vf",
      "crop=iw:ih*0.0275:0:ih*0.0801,scale=16:1:flags=area,format=gray",
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  ).stdout;
  const counts = [];
  for (let frame = 0; frame + 16 <= raw.length; frame += 16) {
    let value = 0;
    for (let bit = 0; bit < 16; bit++) value = (value << 1) | (raw[frame + bit] > 128 ? 1 : 0);
    counts.push(value);
  }
  return counts;
}

function report(counts, { arrivals, cpu }) {
  const distinctAt = [];
  counts.forEach((value, index) => {
    if (index > 0 && value !== counts[index - 1] && arrivals[index] !== undefined) {
      distinctAt.push(arrivals[index]);
    }
  });
  if (distinctAt.length < 2) {
    console.error("fewer than two distinct frames were read");
    process.exit(1);
  }
  const gaps = distinctAt
    .slice(1)
    .map((time, index) => time - distinctAt[index])
    .sort((a, b) => a - b);
  const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))];
  const span = (distinctAt.at(-1) - distinctAt[0]) / 1000;
  const average = cpu.length ? cpu.reduce((sum, value) => sum + value, 0) / cpu.length : 0;
  console.log(
    `distinct/s=${(distinctAt.length / span).toFixed(1)} p95=${p95.toFixed(1)} cpu=${average.toFixed(1)}`,
  );
}
