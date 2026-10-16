import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mutate.mjs");

const REPORT = JSON.stringify({
  files: {
    "src/a.ts": {
      mutants: [
        {
          status: "Killed",
          mutatorName: "BooleanLiteral",
          replacement: "true",
          location: { start: { line: 1 } },
        },
        {
          status: "Survived",
          mutatorName: "BooleanLiteral",
          replacement: "false",
          location: { start: { line: 2 } },
        },
      ],
    },
  },
});

interface Repo {
  readonly dir: string;
  readonly log: string;
  readonly bin: string;
  git(...args: string[]): string;
  commit(files: Record<string, string>): void;
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), "mutate-"));
  const dir = join(root, "clone");
  const bin = join(root, "bin");
  const log = join(root, "stryker.log");
  mkdirSync(dir);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ -n "$CRASH" ]; then echo "$CRASH" >&2; exit 1; fi\nmkdir -p .stryker-tmp/report\necho '${REPORT}' > .stryker-tmp/report/mutation.json\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "change");
  };
  git("init", "-q", "-b", "base");
  commit({ "src/a.ts": "export const a = 1;\n" });
  git("switch", "-q", "-c", "work");
  commit({ "src/a.ts": "export const a = 1;\nexport const b = true;\n" });
  return { dir, log, bin, git, commit };
}

function mutate(r: Repo, cwd = r.dir, crash = "", args: string[] = []) {
  const run = spawnSync(process.execPath, [SCRIPT, "base", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${r.bin}:/usr/bin:/bin`, CRASH: crash },
  });
  return { code: run.status, output: run.stdout + run.stderr };
}

const strykerRuns = (r: Repo) =>
  existsSync(r.log) ? readFileSync(r.log, "utf8").trim().split("\n") : [];

describe("mutate.mjs", () => {
  it("runs Stryker on the changed lines with the branch's incremental file, and prints the mutants left alive", () => {
    const r = repo();
    const first = r.git("rev-list", "--reverse", "base..HEAD").split("\n")[0];
    const common = r.git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();

    const { code, output } = mutate(r);

    expect(strykerRuns(r)).toEqual([
      `exec stryker run --mutate src/a.ts:2-2 --incremental --incrementalFile ${common}/mutate/${first}.json`,
    ]);
    expect(output).toContain("2 mutants on 1 changed ranges; 1 alive.");
    expect(output).toContain("src/a.ts:2 Survived BooleanLiteral: false");
    expect(output).toContain("Kill each one, or explain it in the PR body.");
    expect(code).toBe(1);
  });

  it("ends with Stryker's last error lines and exits 2, not 1, when Stryker fails without a report", () => {
    const r = repo();

    const { code, output } = mutate(r, r.dir, "TypeError: boom");

    expect(output.trimEnd().split("\n").slice(-2)).toEqual([
      "Stryker exited 1 without a report: no mutant was tested.",
      "TypeError: boom",
    ]);
    expect(output).not.toContain("Kill each one");
    expect(code).toBe(2);
  });

  it("reprints the last result without running Stryker when nothing under src/ changed since, even after a commit elsewhere", () => {
    const r = repo();
    mutate(r);
    r.commit({ "docs/notes.md": "A doc-only fix.\n" });

    const { code, output } = mutate(r);

    expect(strykerRuns(r)).toHaveLength(1);
    expect(output).toContain("Nothing under src/ or ui/src/ changed since this branch's last run");
    expect(output).toContain("src/a.ts:2 Survived BooleanLiteral: false");
    expect(code).toBe(1);
  });

  it("runs Stryker again after a commit that changes src/, and when src/ has uncommitted changes", () => {
    const r = repo();
    mutate(r);
    r.commit({ "src/a.ts": "export const a = 1;\nexport const b = false;\n" });
    mutate(r);
    writeFileSync(join(r.dir, "src/a.ts"), "export const a = 2;\nexport const b = false;\n");

    mutate(r);

    expect(strykerRuns(r)).toHaveLength(3);
  });

  it("shares the last result with another worktree of the branch under another local branch name", () => {
    const r = repo();
    mutate(r);
    const other = join(dirname(r.dir), "other");
    r.git("worktree", "add", "-q", "-b", "fix-run", other, "work");

    const { output } = mutate(r, other);

    expect(strykerRuns(r)).toHaveLength(1);
    expect(output).toContain("Nothing under src/ or ui/src/ changed since this branch's last run");
  });

  it("without --max-lines, mutates every changed range in diff order and prints no skip line", () => {
    const r = fourFiles(repo());

    const { output } = mutate(r);

    expect(mutated(r)).toEqual(["src/a.ts:2-2,src/b.ts:1-3,src/c.ts:1-2,src/d.ts:1-1"]);
    expect(output).not.toContain("Skipped");
    expect(output).toContain("on 4 changed ranges");
  });

  it("with --max-lines, takes files by their newest commit, newest first, and stops at the first file that would pass the budget", () => {
    const r = fourFiles(repo());

    const { output } = mutate(r, r.dir, "", ["--max-lines", "4"]);

    expect(mutated(r)).toEqual(["src/a.ts:2-2,src/c.ts:1-2"]);
    expect(output).toContain("on 2 changed ranges");
  });

  it("with --max-lines, prints one line naming the skipped files and changed lines, then each skipped file", () => {
    const r = fourFiles(repo());

    const { output } = mutate(r, r.dir, "", ["--max-lines", "4"]);

    const lines = output.split("\n");
    const at = lines.indexOf("Skipped 2 files and 4 changed lines past --max-lines 4:");
    expect(at).not.toBe(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual(["  src/b.ts", "  src/d.ts"]);
  });

  it("with --max-lines, ranks a file with uncommitted changes before every committed one", () => {
    const r = repo();
    r.commit({ "src/b.ts": "export const x = 1;\n" });
    writeFileSync(join(r.dir, "src/a.ts"), "export const a = 1;\nexport const b = false;\n");

    const { output } = mutate(r, r.dir, "", ["--max-lines", "1"]);

    expect(mutated(r)).toEqual(["src/a.ts:2-2"]);
    expect(output).toContain("  src/b.ts");
  });

  it("with --max-lines, cuts a newest file larger than the budget at the budget and names it as partly skipped", () => {
    const r = repo();
    const ten = Array.from({ length: 10 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
    r.commit({ "src/big.ts": `${ten.join("\n")}\n` });
    r.git("branch", "-f", "base");
    r.commit({ "src/c.ts": "export const c = 1;\n" });
    const edited = ten.map((line, i) =>
      [1, 2, 5, 6, 7, 8].includes(i) ? line.replace(";", "0;") : line,
    );
    r.commit({ "src/big.ts": `${edited.join("\n")}\n` });

    const { output } = mutate(r, r.dir, "", ["--max-lines", "3"]);

    expect(mutated(r)).toEqual(["src/big.ts:2-3,src/big.ts:6-6"]);
    expect(output).toContain("Skipped 2 files and 4 changed lines past --max-lines 3:");
    expect(output).toContain("  src/big.ts (past its first 3 changed lines)");
    expect(output).toContain("  src/c.ts");
  });

  it("runs Stryker again, not reprinting the last result, when the same sources get another --max-lines selection", () => {
    const r = fourFiles(repo());
    mutate(r, r.dir, "", ["--max-lines", "4"]);
    mutate(r, r.dir, "", ["--max-lines", "4"]);

    const { output } = mutate(r, r.dir, "", ["--max-lines", "1"]);

    expect(mutated(r)).toEqual(["src/a.ts:2-2,src/c.ts:1-2", "src/a.ts:2-2"]);
    expect(output).not.toContain("its result stands");
  });

  it("refuses a --max-lines that is not a whole number above 0, without running Stryker", () => {
    const r = repo();
    const ok = mutate(r, r.dir, "", ["--max-lines", "1"]);
    expect(ok.code).toBe(1);

    const { code, output } = mutate(r, r.dir, "", ["--max-lines", "0"]);

    expect(output).toContain("--max-lines takes a whole number of lines above 0.");
    expect(code).toBe(2);
    expect(strykerRuns(r)).toHaveLength(1);
  });
});

function fourFiles(r: Repo): Repo {
  r.commit({ "src/d.ts": "export const d = 1;\n" });
  r.commit({ "src/b.ts": "export const b1 = 1;\nexport const b2 = 2;\nexport const b3 = 3;\n" });
  r.commit({ "src/c.ts": "export const c1 = 1;\nexport const c2 = 2;\n" });
  r.commit({ "src/a.ts": "export const a = 1;\nexport const b = false;\n" });
  return r;
}

const mutated = (r: Repo) => strykerRuns(r).map((line) => line.split(" ")[4]);
