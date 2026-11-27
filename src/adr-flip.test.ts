import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "scripts");
const ADR = "docs/internal/adr/0048-keep-simulators.md";
const OTHER = "docs/internal/adr/0001-a.md";
const INDEX = "docs/internal/adr/README.md";
const PENDING = "Accepted — not yet implemented";
const adr = (status: string) =>
  `# 0048. Keep simulators\n\n- **Status:** ${status}; narrows\n  [ADR 0001](0001-a.md) §2\n- **Date:** 2026-10-24\n\n## Context\n\nA paragraph about an ADR that is ${PENDING}.\n`;
const index = (status: string) =>
  `# ADRs\n\n| ADR | Title | Status |\n|---|---|---|\n| [0001](0001-a.md) | A | ${PENDING} |\n| [0048](0048-keep-simulators.md) | Keep simulators | ${status}; narrows 0001 §2 |\n`;

// why: an origin whose `task/7` holds the ADRs, and a clone of it on `main`, as the
// orchestrator's checkout is: the script must flip the branch without checking it out.
function stack(status: string) {
  const root = mkdtempSync(join(tmpdir(), "adr-flip-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", "main", origin);
  git(origin, "commit", "-q", "--allow-empty", "-m", "base");
  git(origin, "switch", "-qc", "task/7");
  const files = { [ADR]: adr(status), [OTHER]: adr(PENDING), [INDEX]: index(status) };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(origin, dirname(path)), { recursive: true });
    writeFileSync(join(origin, path), text);
  }
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "adr");
  git(origin, "switch", "-q", "main");
  const clone = join(root, "clone");
  git(root, "clone", "-q", origin, clone);
  git(clone, "config", "user.name", "t");
  git(clone, "config", "user.email", "t@t");
  // why: Git for Windows checks files out with CRLF, and the script reads them from a worktree.
  git(clone, "config", "core.autocrlf", "true");
  const before = git(origin, "rev-parse", "task/7");
  const flip = (...args: string[]) => {
    const run = spawnSync(process.execPath, [join(SCRIPTS, "adr-flip.mjs"), ...args], {
      cwd: clone,
      encoding: "utf8",
    });
    return { status: run.status, stdout: run.stdout };
  };
  return { before, flip, tip: () => git(origin, "rev-parse", "task/7"), origin, git };
}

// why: each case clones a repository and the script adds a worktree, commits and pushes: about forty git processes, slow on a Windows runner.
describe("adr-flip.mjs", { timeout: 60_000 }, () => {
  it("pushes one commit that drops 'not yet implemented' from the Status item and the index row", () => {
    const { before, flip, git, origin, tip } = stack(PENDING);

    const result = flip("0048", "--branch", "task/7");

    expect(result).toEqual({ status: 0, stdout: `adr-flip: pushed ${tip()} 0048\n` });
    expect(git(origin, "log", "--format=%P %s", "-1", "task/7")).toBe(
      `${before} docs(adr): 0048 to Accepted (#7)`,
    );
    expect(git(origin, "show", `task/7:${ADR}`)).toBe(adr("Accepted").trim());
    expect(git(origin, "show", `task/7:${INDEX}`)).toBe(index("Accepted").trim());
    expect(git(origin, "diff", "--name-only", before, "task/7")).toBe(`${ADR}\n${INDEX}`);
    expect(
      spawnSync(process.execPath, [join(SCRIPTS, "adr-flip-check.mjs"), "task/7"], {
        cwd: origin,
        encoding: "utf8",
      }).stdout,
    ).toBe("adr-flip: ok 0048\n");
  });

  it("pushes nothing when the ADR already reads Accepted", () => {
    const { before, flip, tip } = stack("Accepted");

    expect(flip("0048", "--branch", "task/7")).toEqual({
      status: 0,
      stdout: "adr-flip: current\n",
    });
    expect(tip()).toBe(before);
  });

  it.each([
    [
      "an ADR that is still Proposed",
      "0048",
      `${ADR}: its Status is not "Accepted — not yet implemented": "- **Status:** Proposed; narrows"`,
    ],
    ["an ADR the branch does not hold", "0099", "0099: no docs/internal/adr/0099-*.md on task/7"],
  ])("refuses %s, and pushes nothing", (_, number, reason) => {
    const { before, flip, tip } = stack("Proposed");

    const result = flip("0001", number, "--branch", "task/7");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`adr-flip: ${reason}`);
    expect(tip()).toBe(before);
  });

  it("exits 64 without a branch or with a number that is not four digits", () => {
    const { flip } = stack(PENDING);

    expect(flip("0048").status).toBe(64);
    expect(flip("48", "--branch", "task/7").status).toBe(64);
  });
});
