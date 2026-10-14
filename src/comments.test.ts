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
  "comments.mjs",
);

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function repo(before: Record<string, string>, after: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "comments-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q", "-b", "base");
  write(dir, before);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  write(dir, after);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "head");
  return dir;
}

function list(dir: string, ...range: string[]): string {
  return execFileSync("node", [SCRIPT, ...range], { cwd: dir, encoding: "utf8" });
}

const filler = (n: number) => Array.from({ length: n }, (_, i) => `const f${i} = ${i};`);

describe("comments.mjs", () => {
  it("lists a comment block the diff adds, whole, with the code line after it", () => {
    const dir = repo(
      { "src/a.ts": "export const a = 1;\n" },
      { "src/a.ts": "export const a = 1;\n/**\n * Says what b is.\n */\nexport const b = 2;\n" },
    );

    expect(list(dir, "base", "HEAD")).toBe(
      [
        "src/a.ts:2-4 (added)",
        "  2 | /**",
        "  3 |  * Says what b is.",
        "  4 |  */",
        "  5 > export const b = 2;",
        "",
      ].join("\n"),
    );
  });

  it("leaves out an unchanged comment next to an added code line, and lists it with --all", () => {
    const before = ["// near", "const x = 0;", ...filler(40), "// far", ""];
    const after = [...before];
    after[1] = "const x = 1;";
    const dir = repo({ "src/a.ts": before.join("\n") }, { "src/a.ts": after.join("\n") });

    expect(list(dir, "base", "HEAD")).toBe("");

    const output = list(dir, "--all", "base", "HEAD");
    expect(output).toContain("src/a.ts:1 (unchanged)\n  1 | // near\n");
    expect(output).toContain("src/a.ts:43 (unchanged)\n  43 | // far\n");
  });

  it("with --all, leaves out the comments of a file the diff does not touch", () => {
    const dir = repo(
      { "src/a.ts": "const a = 0;\n", "src/b.ts": "// untouched\nconst b = 0;\n" },
      { "src/a.ts": "const a = 1;\n" },
    );

    expect(list(dir, "--all", "base", "HEAD")).toBe("");
  });

  it("lists only the block a comment edit touches, and marks a block it changes in part as edited", () => {
    const before = [
      "// other",
      "const x = 0;",
      "/**",
      " * Old.",
      " * Kept.",
      " */",
      "const y = 0;",
      "",
    ];
    const after = [...before];
    after[3] = " * New.";
    const dir = repo({ "src/a.ts": before.join("\n") }, { "src/a.ts": after.join("\n") });

    const output = list(dir, "base", "HEAD");

    expect(output).toContain("src/a.ts:3-6 (edited)");
    expect(output).not.toContain("// other");
  });

  it("leaves out tool directives, and a block of nothing else", () => {
    const dir = repo(
      { "src/a.ts": "export const a = 1;\n" },
      {
        "src/a.ts": [
          "export const a = 1;",
          "// @ts-expect-error the fixture is wrong on purpose",
          "const b: number = 'x';",
          "// fallow-ignore-next-line complexity",
          "const c = 3;",
          "",
        ].join("\n"),
      },
    );

    expect(list(dir, "base", "HEAD")).toBe("");
  });

  it("lists a comment after code on its line, and not a // inside a string", () => {
    const dir = repo(
      { "src/a.ts": "export const a = 1;\n" },
      {
        "src/a.ts":
          'export const a = 1;\nconst url = "https://example.com"; // the mirror\nconst b = "a // b";\n',
      },
    );

    expect(list(dir, "base", "HEAD")).toBe(
      'src/a.ts:2 (added)\n  2 | const url = "https://example.com"; // the mirror\n',
    );
  });

  it("lists shell comments, not the shebang, and skips files that are not code", () => {
    const dir = repo(
      { "run.sh": "#!/usr/bin/env sh\necho a\n", "notes.md": "# Title\n" },
      { "run.sh": "#!/usr/bin/env sh\n# Prints b.\necho b\n", "notes.md": "# Title\n# More\n" },
    );

    expect(list(dir, "base", "HEAD")).toBe("run.sh:2 (added)\n  2 | # Prints b.\n  3 > echo b\n");
  });

  it("without a head, reads the working tree, untracked files included", () => {
    const dir = repo({ "src/a.ts": "export const a = 1;\n" }, {});
    write(dir, {
      "src/a.ts": "export const a = 1;\n// Edited, not committed.\nconst b = 2;\n",
      "src/new.ts": "// Untracked.\nexport const c = 3;\n",
    });

    const output = list(dir, "base");

    expect(output).toContain("src/a.ts:2 (added)");
    expect(output).toContain(
      "src/new.ts:1 (added)\n  1 | // Untracked.\n  2 > export const c = 3;",
    );
  });

  it("leaves out a comment the base branch rewrote after the branch point", () => {
    const dir = repo(
      { "src/a.ts": "// Old wording.\nexport const a = 1;\n" },
      { "src/b.ts": "// Branch's own.\nexport const b = 2;\n" },
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    git("switch", "-q", "base");
    write(dir, { "src/a.ts": "// New wording.\nexport const a = 1;\n" });
    git("commit", "-q", "-am", "base rewrites a comment");
    git("switch", "-q", "work");

    expect(list(dir, "base", "HEAD")).toBe(
      "src/b.ts:1 (added)\n  1 | // Branch's own.\n  2 > export const b = 2;\n",
    );
  });
});
