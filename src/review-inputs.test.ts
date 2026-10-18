import { execFileSync } from "node:child_process";
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

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "review-inputs.sh",
);

// why: the fake answers repo-scoped REST only, as a cloud session's proxy does, and runs each
// `-q` filter through jq, so the script's own filters decide what it sees.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const github = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FILE, "utf8"));
const args = process.argv.slice(2);
const fail = () => {
  process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\\n");
  process.exit(9);
};
if (args[0] !== "api" || args[1] !== "-X" || args[2] !== "GET") fail();
const fields = {};
let filter;
for (let i = 4; i < args.length; i += 2) {
  if (args[i] === "-f") fields[args[i + 1].split("=")[0]] = args[i + 1].split("=")[1];
  else if (args[i] === "-q") filter = args[i + 1];
  else fail();
}
let value = github[args[3]];
if (value === undefined) fail();
if (args[3].endsWith("/comments")) {
  const page = Number(fields.page);
  if (fields.per_page !== "100" || !(page >= 1)) fail();
  value = value.slice((page - 1) * 100, page * 100);
}
process.stdout.write(execFileSync("jq", ["-r", filter], { input: JSON.stringify(value), encoding: "utf8" }));
`;

let root: string;
let work: string;

function git(cwd: string, ...args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "review-inputs-"));
  const origin = join(root, "o", "r.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "--bare");
  work = join(root, "work");
  mkdirSync(join(work, "docs", "internal", "adr"), { recursive: true });
  mkdirSync(join(work, "docs", "internal", "agent-rules"), { recursive: true });
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "docs", "internal", "adr", "README.md"), "# ADRs\n");
  writeFileSync(join(work, "docs", "internal", "agent-rules", "always-in-scope.md"), "# Scope\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "chore: base");
  git(work, "checkout", "-q", "-b", "bug/12");
  writeFileSync(join(work, "src", "a.test.ts"), "test\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "test: red");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main", "bug/12:refs/pull/7/head");
});

const comment = (body: string) => ({ body });
const plain = (n: number) => Array.from({ length: n }, (_, i) => comment(`Comment ${i}.`));

function inputs(
  issue: object,
  comments: readonly { body: string }[],
  previous?: string,
  base = "main",
) {
  const file = join(mkdtempSync(join(root, "gh-")), "github.json");
  writeFileSync(
    file,
    JSON.stringify({
      "repos/o/r/pulls/7": { head: { ref: "bug/12" }, base: { ref: base }, body: null },
      "repos/o/r/issues/12": issue,
      "repos/o/r/issues/12/comments": comments,
      "repos/o/r/issues/5": { body: "Feature\r\nfive." },
    }),
  );
  writeFileSync(join(dirname(file), "gh"), FAKE_GH);
  chmodSync(join(dirname(file), "gh"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(file)}:${process.env.PATH}`,
    FAKE_GH_FILE: file,
    TMPDIR: root,
  };
  delete env.GH_REPO;
  const stdout = execFileSync("sh", [SCRIPT, "7", ...(previous === undefined ? [] : [previous])], {
    cwd: work,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = stdout.trim().split("\n").at(-1) ?? "";
  const read = (name: string) =>
    existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8") : null;
  return { read };
}

const BUG = { body: "The bug.", labels: [{ name: "bug:ready" }], parent_issue_url: null };

describe("review-inputs.sh over repo-scoped REST", { timeout: 30_000 }, () => {
  it("writes the issue the branch names, and its parent from parent_issue_url", () => {
    const parented = { ...BUG, parent_issue_url: "https://api.github.com/repos/o/r/issues/5" };
    const result = inputs(parented, []);
    expect(result.read("issue.md")).toBe("The bug.\n");
    expect(result.read("feature.md")).toBe("Feature\nfive.\n");
    expect(inputs(BUG, []).read("feature.md")).toBeNull();
  });

  it("takes the last triage report across pages of comments, page 2 included", () => {
    const comments = [
      ...plain(99),
      comment("## Simplest fix\nold"),
      comment("## Simplest fix\nnew"),
      comment("Thanks."),
    ];
    expect(inputs(BUG, comments).read("triage.md")).toBe("## Simplest fix\nnew\n");
  });

  it("keeps page 1's triage report when page 2 has none", () => {
    const comments = [...plain(99), comment("## Simplest fix\nold"), comment("Thanks.")];
    expect(inputs(BUG, comments).read("triage.md")).toBe("## Simplest fix\nold\n");
  });

  it("writes no triage.md for a bug with no triage report", () => {
    expect(inputs(BUG, plain(3)).read("triage.md")).toBeNull();
    expect(inputs(BUG, [comment("## Simplest fix\nold")]).read("triage.md")).not.toBeNull();
  });
  it("rejects unavailable or non-ancestor previous commits instead of losing the fix delta", () => {
    expect(() => inputs(BUG, [], "deadbeef")).toThrow(/previous commit/);
    git(work, "checkout", "-q", "-b", "unrelated", "main");
    writeFileSync(join(work, "unrelated.md"), "other branch");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "docs: unrelated");
    const other = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    git(work, "checkout", "-q", "bug/12");
    expect(() => inputs(BUG, [], other)).toThrow(/ancestor/);
  });

  it("pins the actual stacked base and limits fix.patch to changes since previous", () => {
    git(work, "branch", "stack-base", "bug/12");
    const previous = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(work, "src", "fix.test.ts"), "fixed assertion\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "test: fix");
    git(work, "push", "-q", "origin", "stack-base", "bug/12:refs/pull/7/head");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const result = inputs(BUG, [], previous, "stack-base");
    expect(result.read("base")).toBe(`${previous}\n`);
    expect(result.read("merge-base")).toBe(`${previous}\n`);
    expect(result.read("previous")).toBe(`${previous}\n`);
    expect(result.read("commit")).toBe(`${head}\n`);
    expect(result.read("fix.patch")).toContain("+fixed assertion");
    expect(result.read("diff.patch")).toContain("fix.test.ts");
    expect(result.read("diff.patch")).not.toContain("a.test.ts");
  });
});
