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
// beside the iOS program is checked without a Swift toolchain.
function fakeSwift(repo: string): string {
  const bin = join(repo, "fake-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "swift"),
    [
      "#!/bin/sh",
      'while [ "$1" != "--scratch-path" ]; do shift; done',
      '/bin/mkdir -p "$2/release"',
      'echo program > "$2/release/simlock-screen-capture"',
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
    "ships the iOS capture program with serve-sim's NOTICE.md and license, and leaves them out when it is not built",
    () => {
      const repo = scratchRepo("the real server", sha256("the real server"));
      const run = (path: string) =>
        execFileSync(process.execPath, [join(repo, "scripts", "build-capture.mjs")], {
          env: { ...process.env, PATH: path },
          stdio: "pipe",
        });
      const shipped = join(repo, "dist", "vendor", "screen-capture");

      run("");
      expect(existsSync(join(repo, "dist", "bin", "simlock-screen-capture"))).toBe(false);
      expect(existsSync(shipped)).toBe(false);

      run(fakeSwift(repo));
      expect(existsSync(join(repo, "dist", "bin", "simlock-screen-capture"))).toBe(true);
      expect(readFileSync(join(shipped, "NOTICE.md"), "utf8")).toBe("notice of screen-capture");
      expect(readFileSync(join(shipped, "LICENSES", "serve-sim.APACHE-2.0.txt"), "utf8")).toBe(
        "license of screen-capture",
      );
    },
  );
});
