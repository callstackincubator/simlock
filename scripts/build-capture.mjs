#!/usr/bin/env node
// `pnpm build:capture`: puts the screen-capture artifacts beside the compiled daemon, which looks for
// them there. The scrcpy server is copied into dist/vendor/scrcpy/ once its SHA-256 matches the pin in
// vendor/scrcpy/SHA256SUMS.txt; a mismatch fails the build. On macOS with a Swift toolchain the iOS
// capture program in vendor/screen-capture/ is built and copied to dist/bin/simlock-screen-capture.
// Anywhere else it is skipped with a note, and the daemon reports iOS streams as unavailable.
// Each artifact ships with its upstream's NOTICE.md and LICENSES/ in dist/vendor/<dir>/, because the
// package publishes dist/ and Apache-2.0 §4(a) asks that whoever gets a binary gets its license too.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function copyNotices(dir) {
  const target = join(dist, "vendor", dir);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(root, "vendor", dir, "NOTICE.md"), join(target, "NOTICE.md"));
  cpSync(join(root, "vendor", dir, "LICENSES"), join(target, "LICENSES"), { recursive: true });
}

function copyScrcpyServer() {
  const sums = readFileSync(join(root, "vendor/scrcpy/SHA256SUMS.txt"), "utf8").trim().split("\n");
  for (const line of sums) {
    const [expected, name] = line.trim().split(/\s+/u);
    const source = join(root, "vendor/scrcpy", name);
    const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (actual !== expected) {
      console.error(`build-capture: ${name} does not match its pinned SHA-256 (${actual})`);
      process.exit(1);
    }
    const target = join(dist, "vendor/scrcpy", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  copyNotices("scrcpy");
}

function buildIosCapture() {
  if (process.platform !== "darwin") {
    console.log("build-capture: not macOS, skipping the iOS screen-capture program");
    return;
  }
  const packagePath = join(root, "vendor/screen-capture");
  const scratch = join(packagePath, ".build/out");
  const built = spawnSync(
    "swift",
    ["build", "-c", "release", "--package-path", packagePath, "--scratch-path", scratch],
    { stdio: "inherit" },
  );
  if (built.error !== undefined || built.status !== 0) {
    console.warn(
      "build-capture: could not build the iOS screen-capture program (is Xcode installed and selected?); " +
        "iOS screen streams will be unavailable",
    );
    return;
  }
  const target = join(dist, "bin/simlock-screen-capture");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(scratch, "release/simlock-screen-capture"), target);
  chmodSync(target, 0o755);
  copyNotices("screen-capture");
}

copyScrcpyServer();
buildIosCapture();
