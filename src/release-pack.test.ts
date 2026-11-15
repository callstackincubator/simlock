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

function listing(tarball: string): string {
  return spawnSync("tar", ["tvzf", tarball], { encoding: "utf8" }).stdout;
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

    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", packStepScript()],
      {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: root, VERSION },
      },
    );
    expect(result.stderr).not.toContain("::error::");
    expect(result.status).toBe(0);
    return join(root, "package");
  }

  it("keeps both iOS capture programs executable in the tarball, as it keeps the CLI entry", () => {
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
  });

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

  it("checks both package names on npm before any tag, commits both manifests, publishes @simlock/e2e before simlock, and attaches both tarballs", () => {
    const plan = step("The tag and the npm versions are free");
    expect(plan).toContain("for name in simlock @simlock/e2e");
    expect(plan).toContain('"::error::$name@$VERSION is on npm already"');
    expect(plan).toContain(
      "::error::@simlock/e2e is not on npm yet: create the simlock organisation, publish a 0.0.0 placeholder by hand and add its trusted publisher, then run the release again",
    );

    expect(step("Release commit and tag")).toContain(
      "git add package.json packages/e2e/package.json CHANGELOG.md",
    );

    const check = step("The tarballs are the planned version, and npm can publish without a token");
    expect(check).toContain("simlock-e2e-$VERSION.tgz");
    expect(check).toContain("the tarball is $name@$packed, not $VERSION");

    const publishE2e = step("Publish @simlock/e2e");
    const publishSimlock = step("Publish simlock");
    expect(publishE2e).toContain(
      'npm publish "simlock-e2e-$VERSION.tgz" --provenance --access public --tag "$DIST_TAG"',
    );
    expect(publishSimlock).toContain(
      'npm publish "simlock-$VERSION.tgz" --provenance --access public --tag "$DIST_TAG"',
    );
    expect(workflow.indexOf(publishE2e)).toBeLessThan(workflow.indexOf(publishSimlock));

    expect(step("Create the release")).toContain(
      '"simlock-$VERSION.tgz" "simlock-e2e-$VERSION.tgz" SHA256SUMS.txt',
    );
  });

  it("recovers a half-published release by skipping each package whose exact version is already on npm", () => {
    for (const [stepName, tarball, name] of [
      ["Publish @simlock/e2e", "simlock-e2e-$VERSION.tgz", "@simlock/e2e"],
      ["Publish simlock", "simlock-$VERSION.tgz", "simlock"],
    ] as const) {
      const publish = step(stepName);
      expect(publish).toContain(`npm view "${name}@$VERSION" version`);
      expect(publish.indexOf("npm view")).toBeLessThan(publish.indexOf(`npm publish "${tarball}"`));
      expect(publish).toContain(`${name}@$VERSION is on npm already, skipping`);
    }
  });
});
