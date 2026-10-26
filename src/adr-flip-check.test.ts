import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "adr-flip-check.mjs",
);
const ADR = "docs/internal/adr/0048-keep-simulators.md";
const INDEX = "docs/internal/adr/README.md";
const adr = (status: string, context = "Simulators live in the set.") =>
  `# 0048. Keep simulators\n\n- **Status:** ${status}\n  for a worker\n- **Date:** 2026-10-24\n\n## Context\n\n${context}\n`;
const index = (status: string) =>
  `# ADRs\n\n| ADR | Title | Status |\n|---|---|---|\n| [0001](0001-a.md) | A | Accepted |\n| [0048](0048-keep-simulators.md) | Keep simulators | ${status} |\n`;

// why: each case is one commit on top of a base that holds the ADR not yet implemented.
function flip(files: Readonly<Record<string, string>>) {
  const repo = mkdtempSync(join(tmpdir(), "adr-flip-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  const write = (all: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  git("init", "-q");
  write({
    [ADR]: adr("Accepted — not yet implemented"),
    [INDEX]: index("Accepted — not yet implemented"),
  });
  git("add", ".");
  git("commit", "-qm", "base");
  write(files);
  git("add", ".");
  git("commit", "-qm", "adr");
  const result = spawnSync(process.execPath, [SCRIPT, "HEAD"], { cwd: repo, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

describe("adr-flip-check.mjs", () => {
  it("passes a commit that flips the Status line and the index row, and nothing else", () => {
    expect(flip({ [ADR]: adr("Accepted"), [INDEX]: index("Accepted") })).toEqual({
      status: 0,
      stdout: "adr-flip: ok 0048\n",
    });
  });

  it.each([
    [
      "a paragraph",
      { [ADR]: adr("Accepted", "Simulators move.") },
      "changes more than its Status line",
    ],
    ["a status that is not Accepted", { [ADR]: adr("Proposed") }, "does not read Accepted"],
    ["another file", { [ADR]: adr("Accepted"), "src/a.ts": "x\n" }, "src/a.ts: not an ADR file"],
    [
      "another index row",
      {
        [ADR]: adr("Accepted"),
        [INDEX]: index("Accepted").replace("| A | Accepted", "| A | Rejected"),
      },
      "not the index row of an ADR this commit flips",
    ],
    ["no ADR", { [INDEX]: index("Accepted") }, "not the index row"],
  ])("fails a commit that changes %s", (_, files, reason) => {
    const result = flip(files);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(reason);
  });
});
