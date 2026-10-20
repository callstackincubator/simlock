import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "build-capture.mjs");
let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

// why: a copy of the script beside a scratch vendor/ tree, because the script finds the repo from its
// own location and the claim is about what it does with the files it finds there.
function scratchRepo(server: string, digest: string): string {
  root = mkdtempSync(join(tmpdir(), "simlock-build-capture-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "vendor", "scrcpy"), { recursive: true });
  cpSync(SCRIPT, join(root, "scripts", "build-capture.mjs"));
  writeFileSync(join(root, "vendor", "scrcpy", "scrcpy-server-v5.0.1"), server);
  writeFileSync(
    join(root, "vendor", "scrcpy", "SHA256SUMS.txt"),
    `${digest}  scrcpy-server-v5.0.1\n`,
  );
  for (const [dir, license] of [
    ["scrcpy", "scrcpy.APACHE-2.0.txt"],
    ["screen-capture", "serve-sim.APACHE-2.0.txt"],
  ] as const) {
    mkdirSync(join(root, "vendor", dir, "LICENSES"), { recursive: true });
    writeFileSync(join(root, "vendor", dir, "NOTICE.md"), `notice of ${dir}`);
    writeFileSync(join(root, "vendor", dir, "LICENSES", license), `license of ${dir}`);
  }
  return root;
}

// why: a `swift` that writes the program where `swift build` would, so the claim about what ships
// beside the iOS programs is checked without a Swift toolchain. It honours `--product` like the
// real build does, and fails the products named in SIMLOCK_FAKE_SWIFT_FAIL so a test can have one
// program build and the other not.
function fakeSwift(repo: string): string {
  const bin = join(repo, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "swift"),
    [
      "#!/bin/sh",
      "product=''",
      'scratch=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "--product" ]; then shift; product="$1"; fi',
      '  if [ "$1" = "--scratch-path" ]; then shift; scratch="$1"; fi',
      "  shift",
      "done",
      'case ",$SIMLOCK_FAKE_SWIFT_FAIL," in *",$product,"*) exit 1 ;; esac',
      '/bin/mkdir -p "$scratch/release"',
      'echo program > "$scratch/release/$product"',
    ].join("\n"),
  );
  chmodSync(join(bin, "swift"), 0o755);
  return bin;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("scripts/build-capture.mjs", () => {
  it("fails the build, and copies nothing, when the scrcpy server does not match its pinned SHA-256", () => {
    const repo = scratchRepo("tampered", sha256("the real server"));
    const run = spawnSync(process.execPath, [join(repo, "scripts", "build-capture.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match its pinned SHA-256");
    expect(existsSync(join(repo, "dist", "vendor", "scrcpy", "scrcpy-server-v5.0.1"))).toBe(false);
  });

  it("copies a scrcpy server that matches its pin into dist, byte for byte", () => {
    const repo = scratchRepo("the real server", sha256("the real server"));
    execFileSync(process.execPath, [join(repo, "scripts", "build-capture.mjs")], {
      env: { ...process.env, PATH: "" },
      stdio: "pipe",
    });
    expect(
      readFileSync(join(repo, "dist", "vendor", "scrcpy", "scrcpy-server-v5.0.1"), "utf8"),
    ).toBe("the real server");
  });

  it("ships the scrcpy server with its NOTICE.md and every license it needs", () => {
    const repo = scratchRepo("the real server", sha256("the real server"));
    execFileSync(process.execPath, [join(repo, "scripts", "build-capture.mjs")], {
      env: { ...process.env, PATH: "" },
      stdio: "pipe",
    });
    const shipped = join(repo, "dist", "vendor", "scrcpy");
    expect(readFileSync(join(shipped, "NOTICE.md"), "utf8")).toBe("notice of scrcpy");
    expect(readFileSync(join(shipped, "LICENSES", "scrcpy.APACHE-2.0.txt"), "utf8")).toBe(
      "license of scrcpy",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "builds each iOS capture program on its own, ships each one that built with serve-sim's NOTICE.md and license, and leaves out what did not build",
    () => {
      const repo = scratchRepo("the real server", sha256("the real server"));
      const run = (path: string, fail = "") =>
        spawnSync(process.execPath, [join(repo, "scripts", "build-capture.mjs")], {
          encoding: "utf8",
          env: { ...process.env, PATH: path, SIMLOCK_FAKE_SWIFT_FAIL: fail },
        });
      const shipped = join(repo, "dist", "vendor", "screen-capture");
      const simulatorProgram = join(repo, "dist", "bin", "simlock-screen-capture");
      const deviceProgram = join(repo, "dist", "bin", "simlock-device-capture");

      run("");
      expect(existsSync(simulatorProgram)).toBe(false);
      expect(existsSync(deviceProgram)).toBe(false);
      expect(existsSync(shipped)).toBe(false);

      run(fakeSwift(repo));
      expect(existsSync(simulatorProgram)).toBe(true);
      expect(existsSync(deviceProgram)).toBe(true);
      expect(readFileSync(join(shipped, "NOTICE.md"), "utf8")).toBe("notice of screen-capture");
      expect(readFileSync(join(shipped, "LICENSES", "serve-sim.APACHE-2.0.txt"), "utf8")).toBe(
        "license of screen-capture",
      );

      rmSync(join(repo, "dist"), { force: true, recursive: true });
      const deviceFailed = run(fakeSwift(repo), "simlock-device-capture");
      expect(existsSync(simulatorProgram)).toBe(true);
      expect(existsSync(deviceProgram)).toBe(false);
      expect(existsSync(join(shipped, "NOTICE.md"))).toBe(true);
      expect(deviceFailed.stdout + deviceFailed.stderr).toMatch(/physical iPhone streams/iu);

      rmSync(join(repo, "dist"), { force: true, recursive: true });
      run(fakeSwift(repo), "simlock-screen-capture");
      expect(existsSync(simulatorProgram)).toBe(false);
      expect(existsSync(deviceProgram)).toBe(true);
      expect(existsSync(join(shipped, "NOTICE.md"))).toBe(true);
    },
  );
});
