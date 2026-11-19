import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BASH, fakeCommandEnv, writeFakeCommand } from "./test-support/fake-command.js";

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

// why: a tar that reads "C:" as a host name cannot open a Windows path, so it runs in the folder.
function listing(tarball: string): string {
  return spawnSync("tar", ["tvzf", basename(tarball)], {
    cwd: dirname(tarball),
    encoding: "utf8",
  }).stdout;
}

// why: the bits that matter are the ones in the tarballs users install, so the claims are checked
// on what the release's own Pack step produces from a built tree with the modes the build sets
// (scripts/build-capture.mjs chmods each capture program 0755).
describe("the Release workflow's Pack step (.github/workflows/release.yml)", () => {
  function pack(): string {
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
    const provider = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/e2e/package.json"), "utf8"),
    ) as Record<string, unknown>;
    write(
      join(project, "packages/e2e/package.json"),
      JSON.stringify(
        { files: provider["files"], name: "@simlock/e2e", type: "module", version: VERSION },
        null,
        2,
      ),
      0o644,
    );
    write(join(project, "packages/e2e/README.md"), "readme\n", 0o644);
    write(join(project, "packages/e2e/dist/index.js"), "export {};\n", 0o644);
    write(join(project, "packages/e2e/dist/index.d.ts"), "export {};\n", 0o644);
    write(join(project, "packages/e2e/dist/index.test.js"), "export {};\n", 0o644);
    write(join(project, "packages/e2e/dist/index.test.d.ts"), "export {};\n", 0o644);
    write(join(project, "packages/e2e/dist/config.sample.js"), "export {};\n", 0o644);

    // why: Git Bash ships sha256sum but not the shasum the Pack step calls.
    const shims = join(root, "shims");
    mkdirSync(shims);
    if (process.platform === "win32") {
      writeFakeCommand(shims, "shasum", '#!/bin/sh\nshift 2\nexec sha256sum --text "$@"\n');
    }
    const result = spawnSync(
      BASH,
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", packStepScript()],
      {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(process.platform === "win32" ? fakeCommandEnv(shims) : {}),
          RUNNER_TEMP: root,
          VERSION,
        },
      },
    );
    expect(result.stderr).not.toContain("::error::");
    expect(result.status, result.stderr).toBe(0);
    return join(root, "package");
  }

  // why: NTFS has no executable bit, so a Windows host cannot make the tarball's modes; the
  // Release workflow packs on a macOS runner.
  it.skipIf(process.platform === "win32")(
    "keeps both iOS capture programs executable in the tarball, as it keeps the CLI entry",
    () => {
      const modes = Object.fromEntries(
        listing(join(pack(), `simlock-${VERSION}.tgz`))
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
    },
  );

  it("packs simlock and @simlock/e2e at one version, the second with its built files and no test file, and lists both in SHA256SUMS.txt", () => {
    const folder = pack();
    const files = listing(join(folder, `simlock-e2e-${VERSION}.tgz`))
      .split("\n")
      .map((line) => line.trim().split(/\s+/).at(-1));
    expect(files).toContain("package/dist/index.js");
    expect(files).toContain("package/dist/index.d.ts");
    expect(files.filter((file) => /\.test\.|sample/u.test(file ?? ""))).toEqual([]);
    expect(
      readFileSync(join(folder, "SHA256SUMS.txt"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/).at(-1))
        .sort(),
    ).toEqual([`simlock-${VERSION}.tgz`, `simlock-e2e-${VERSION}.tgz`]);
  });
});

describe("the Release workflow's plan, tag, publish and release steps (.github/workflows/release.yml)", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  const step = (name: string): string =>
    new RegExp(`\\n {6}- name: ${name}\\n[\\s\\S]*?(?=\\n {6}- |\\n\\n)`, "u").exec(
      workflow,
    )?.[0] ?? "";
  // why: the run script of a step with the YAML indent removed, so a block is compared line by line.
  const script = (name: string): string =>
    (/\n {8}run: \|\n((?: {10}.*\n?|\n)*)/.exec(step(name))?.[1] ?? "").replace(/^ {10}/gm, "");
  // why: the match stops at the next job key, so a job without an `if:` reads as empty instead of borrowing the next job's.
  const jobCondition = (jobName: string): string =>
    new RegExp(
      `\\n {4}name: ${jobName}\\n(?:(?! {2}[a-z-]+:\\n)[^\\n]*\\n)*? {4}if: (.*)\\n`,
      "u",
    ).exec(workflow)?.[1] ?? "";
  const block = (...lines: string[]): string => lines.join("\n");
  const inLoop = (text: string): string => text.replace(/^/gmu, "  ");

  it("the workflow text runs the plan's three refusals on the exact conditions, before any tag", () => {
    expect(jobCondition("Plan")).toBe("github.ref == 'refs/heads/main' || inputs.dry_run");
    const plan = script("The tag and the npm versions are free");
    expect(plan).toContain(
      block(
        'if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then',
        '  echo "::error::$TAG exists already"',
        "  exit 1",
        "fi",
      ),
    );
    expect(plan).toContain("for name in simlock @simlock/e2e; do");
    expect(plan).toContain(
      inLoop(
        block(
          'if [ "$status" = 404 ] && [ "$name" = "@simlock/e2e" ]; then',
          '  echo "::error::@simlock/e2e is not on npm yet: create the simlock organisation, publish a 0.0.0 placeholder by hand and add its trusted publisher, then run the release again"',
          "  exit 1",
          "fi",
          'if [ "$status" != 200 ]; then',
          '  echo "::error::npm answered $status for $name"',
          "  exit 1",
          "fi",
        ),
      ),
    );
    expect(plan).toContain(
      inLoop(
        block(
          'published=$(jq -r --arg v "$VERSION" \'.versions[$v].version // empty\' "$RUNNER_TEMP/npm.json")',
          'if [ -n "$published" ]; then',
          '  echo "::error::$name@$VERSION is on npm already"',
          "  exit 1",
          "fi",
        ),
      ),
    );
  });

  it("the workflow text tags, publishes and releases only when the run is not a dry run, and commits both manifests", () => {
    for (const job of ["Tag", "Publish to npm", "GitHub release"]) {
      expect(jobCondition(job)).toBe("${{ !inputs.dry_run }}");
    }
    expect(script("Release commit and tag")).toContain(
      "git add package.json packages/e2e/package.json CHANGELOG.md",
    );
    const check = script(
      "The tarballs are the planned version, and npm can publish without a token",
    );
    expect(check).toContain('for tarball in "simlock-$VERSION.tgz" "simlock-e2e-$VERSION.tgz"; do');
    expect(check).toContain(
      inLoop(
        block(
          'if [ "$packed" != "$VERSION" ]; then',
          '  echo "::error::the tarball is $name@$packed, not $VERSION"',
          "  exit 1",
          "fi",
        ),
      ),
    );
  });

  it("the workflow text publishes @simlock/e2e before simlock, each skipping only when npm view finds its exact version", () => {
    const publishes = [
      ["Publish @simlock/e2e", "simlock-e2e-$VERSION.tgz", "@simlock/e2e"],
      ["Publish simlock", "simlock-$VERSION.tgz", "simlock"],
    ] as const;
    for (const [stepName, tarball, name] of publishes) {
      expect(script(stepName)).toBe(
        block(
          `if npm view "${name}@$VERSION" version >/dev/null 2>&1; then`,
          `  echo "${name}@$VERSION is on npm already, skipping"`,
          "  exit 0",
          "fi",
          `npm publish "${tarball}" --provenance --access public --tag "$DIST_TAG"`,
        ),
      );
    }
    expect(workflow.indexOf(step("Publish @simlock/e2e"))).toBeLessThan(
      workflow.indexOf(step("Publish simlock")),
    );
  });

  it("the workflow text attaches both tarballs and the checksums to the release", () => {
    expect(script("Create the release")).toContain(
      '"simlock-$VERSION.tgz" "simlock-e2e-$VERSION.tgz" SHA256SUMS.txt',
    );
  });
});
