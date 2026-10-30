import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const VERSION = "0.0.0-pack";
let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

function packStepScript(): string {
  const release = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  const step = /\n {6}- name: Pack\n[\s\S]*?(?=\n {6}- |\n\n)/.exec(release)?.[0] ?? "";
  const body = /\n {8}run: \|\n((?: {10}.*\n?|\n)*)/.exec(step)?.[1] ?? "";
  return body.replace(/^ {10}/gm, "");
}

function write(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

// why: the bits that matter are the ones in the tarball users install, so the claim is checked
// on what the release's own Pack step produces from a built tree with the modes the build sets
// (scripts/build-capture.mjs chmods each capture program 0755).
describe("the Release workflow's Pack step (.github/workflows/release.yml)", () => {
  it("keeps both iOS capture programs executable in the tarball, as it keeps the CLI entry", () => {
    root = mkdtempSync(join(tmpdir(), "simlock-pack-"));
    const project = join(root, "project");
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const { bin, devEngines, files } = manifest;
    write(
      join(project, "package.json"),
      JSON.stringify({ bin, devEngines, files, name: "simlock", version: VERSION }, null, 2),
      0o644,
    );
    write(join(project, "dist/cli/main.js"), "#!/usr/bin/env node\n", 0o755);
    write(join(project, "dist/bin/simlock-screen-capture"), "binary\n", 0o755);
    write(join(project, "dist/bin/simlock-device-capture"), "binary\n", 0o755);
    write(join(project, "dist/vendor/scrcpy/NOTICE.md"), "notice\n", 0o644);

    const pack = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", packStepScript()],
      {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: root, VERSION },
      },
    );
    expect(pack.stderr).not.toContain("::error::");
    expect(pack.status).toBe(0);

    const listing = spawnSync("tar", ["tvzf", join(root, "package", `simlock-${VERSION}.tgz`)], {
      encoding: "utf8",
    }).stdout;
    const modes = Object.fromEntries(
      listing
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields.length > 1)
        .map((fields) => [fields.at(-1), fields[0]]),
    );
    expect({
      cli: modes["package/dist/cli/main.js"],
      deviceCapture: modes["package/dist/bin/simlock-device-capture"],
      screenCapture: modes["package/dist/bin/simlock-screen-capture"],
    }).toEqual({
      cli: "-rwxr-xr-x",
      deviceCapture: "-rwxr-xr-x",
      screenCapture: "-rwxr-xr-x",
    });
  });
});
