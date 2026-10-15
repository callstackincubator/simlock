import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  return root;
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
});
