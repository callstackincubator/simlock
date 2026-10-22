import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "release.mjs");
const REPOSITORY = "https://github.com/example/simlock";
let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

// why: the script reads the current directory, so each claim gets a scratch one with only the
// files the claim is about.
function scratch(files: Record<string, string>, version = "0.3.0"): string {
  root = mkdtempSync(join(tmpdir(), "simlock-release-"));
  const pkg = { name: "simlock", version, repository: { type: "git", url: `${REPOSITORY}.git` } };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

function run(cwd: string, args: string[], stdin = "") {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    input: stdin,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("scripts/release.mjs plan", () => {
  it("moves 0.X for a feature and 0.X.Y for a patch, and tags both v<version>", () => {
    const cwd = scratch({}, "0.3.4");
    expect(run(cwd, ["plan", "--bump", "feature"], "fix: a\n").stdout).toBe(
      "version=0.4.0\ntag=v0.4.0\nbump=feature\n",
    );
    expect(run(cwd, ["plan", "--bump", "patch"], "feat: a\n").stdout).toBe(
      "version=0.3.5\ntag=v0.3.5\nbump=patch\n",
    );
  });

  it("auto is a feature when a message is a feat or marks a break, else a patch", () => {
    const cwd = scratch({});
    const planned = (messages: string) => run(cwd, ["plan", "--bump", "auto"], messages).stdout;
    expect(planned("fix(core): a (#1)\nchore(agents): b (#2)\n")).toContain("bump=patch\n");
    expect(planned("fix: a\nfeat(gateway): b (#3)\n")).toContain("bump=feature\n");
    expect(planned("fix!(core): a\n")).toContain("bump=patch\n");
    expect(planned("fix(core)!: a\n")).toContain("bump=feature\n");
    expect(planned("fix: a\n\nBREAKING CHANGE: the wire moved\n")).toContain("bump=feature\n");
  });

  it("fails with nothing to release when no message arrives, and prints no version", () => {
    const result = run(scratch({}), ["plan", "--bump", "feature"], "\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("nothing to release");
  });

  it("fails without a bump, and on a version that is not three numbers", () => {
    expect(run(scratch({}), ["plan"], "feat: a\n").status).toBe(1);
    const result = run(scratch({}, "0.4.0-nightly.1"), ["plan", "--bump", "patch"], "feat: a\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0.4.0-nightly.1");
  });
});

describe("scripts/release.mjs bump", () => {
  it("writes the version into package.json and changes nothing else, keeping the formatting", () => {
    const cwd = scratch({});
    const before = readFileSync(join(cwd, "package.json"), "utf8");
    expect(run(cwd, ["bump", "0.4.0"]).status).toBe(0);
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(
      before.replace('"0.3.0"', '"0.4.0"'),
    );
  });

  it("refuses a version that is not three numbers", () => {
    const cwd = scratch({});
    expect(run(cwd, ["bump", "v0.4.0"]).status).toBe(1);
    expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version).toBe("0.3.0");
  });
});

describe("scripts/release.mjs changelog", () => {
  const notes =
    "## What's Changed\n* feat: a by @x in https://example/1\n\n## New Contributors\n* @x\n";
  const released = "## [0.3.0](x/compare/v0.2.0...v0.3.0) (2026-09-03)";

  it("inserts the release above the first released section, below what precedes it, with the compare link and today's date", () => {
    const cwd = scratch({
      "CHANGELOG.md": `# Changelog\n\n## Unreleased\n\nsoon\n\n${released}\n\nold\n`,
      "notes.md": notes,
    });
    expect(run(cwd, ["changelog", "0.4.0", "v0.3.0", "notes.md"]).status).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(
      [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "soon",
        "",
        `## [0.4.0](${REPOSITORY}/compare/v0.3.0...v0.4.0) (${today})`,
        "",
        "### What's Changed",
        "* feat: a by @x in https://example/1",
        "",
        "### New Contributors",
        "* @x",
        "",
        released,
        "",
        "old",
        "",
      ].join("\n"),
    );
  });

  it("appends the first release, without a compare link, when no section has been released", () => {
    const cwd = scratch({ "CHANGELOG.md": "# Changelog\n", "notes.md": notes });
    expect(run(cwd, ["changelog", "0.1.0", "", "notes.md"]).status).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(
      `# Changelog\n\n## 0.1.0 (${today})\n\n### What's Changed\n* feat: a by @x in https://example/1\n\n### New Contributors\n* @x\n`,
    );
  });

  it("leaves CHANGELOG.md alone when the notes file is missing", () => {
    const cwd = scratch({ "CHANGELOG.md": "# Changelog\n" });
    expect(run(cwd, ["changelog", "0.4.0", "v0.3.0", "missing.md"]).status).toBe(1);
    expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe("# Changelog\n");
  });
});
