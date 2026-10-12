import { execFileSync } from "node:child_process";
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
  "comment-lint.mjs",
);

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function repo(before: Record<string, string>, after: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "comment-lint-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q", "-b", "base");
  write(dir, { "README.md": "# Base\n", ...before });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  write(dir, after);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "head");
  return dir;
}

function lint(dir: string, ...args: string[]) {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--base", "base", "--head", "HEAD", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

const REASON = 'a comment starts with "why:" or goes (architecture rule 17)';

describe("comment-lint.mjs", () => {
  it("accepts a why comment, a link, a script's usage header and a tool directive, and rejects a comment that says what", () => {
    const dir = repo(
      {},
      {
        "src/a.ts": [
          "// why: the API answers 304 for a file it has not re-read yet",
          "const a = 1;",
          "// see https://github.com/example/upstream/issues/12",
          "const b = 2;",
          "// Says what c is.",
          "const c = 3;",
          "// @ts-expect-error the fixture is wrong on purpose",
          "const d: number = 'x';",
          "",
        ].join("\n"),
        "scripts/run.mjs": [
          "#!/usr/bin/env node",
          "// `node scripts/run.mjs`: the usage header, allowed where it is.",
          "const run = 1;",
          "// Says what later is.",
          "const later = 2;",
          "",
        ].join("\n"),
      },
    );

    const result = lint(dir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([`scripts/run.mjs:4: ${REASON}`, `src/a.ts:5: ${REASON}`]);
  });

  it("accepts a doc comment on an export the client or admin entry point re-exports, and rejects one elsewhere", () => {
    const dir = repo(
      {},
      {
        "src/client/index.ts": 'export type { Foo } from "../contract/types.js";\n',
        "src/contract/types.ts": "/** A foo, as the client sees it. */\nexport type Foo = 1;\n",
        "src/core/x.ts": "/** The x. */\nexport const x = 1;\n",
      },
    );

    const result = lint(dir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([`src/core/x.ts:1: ${REASON}`]);
  });

  it("judges a trailing comment by its own text, and does not take a regex literal ending in // for one", () => {
    const dir = repo(
      {},
      {
        "src/a.ts": [
          "const a = 1; // why: the driver counts from one",
          "const b = 2; // two",
          "const URL = /https?:\\/\\//;",
          "",
        ].join("\n"),
      },
    );

    const result = lint(dir);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([`src/a.ts:2: ${REASON}`]);
  });

  it("checks only the files given and only the blocks the diff adds or edits, and with --all the unchanged ones too", () => {
    const dir = repo(
      { "src/a.ts": "// old what\nconst a = 0;\n" },
      { "src/a.ts": "// old what\nconst a = 1;\n", "src/b.ts": "// new what\nconst b = 1;\n" },
    );

    expect(lint(dir, "src/a.ts")).toEqual({ status: 0, lines: [] });
    expect(lint(dir)).toEqual({ status: 1, lines: [`src/b.ts:1: ${REASON}`] });
    expect(lint(dir, "--all").lines).toEqual([`src/a.ts:1: ${REASON}`, `src/b.ts:1: ${REASON}`]);
  });
});
