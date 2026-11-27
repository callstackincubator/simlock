import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
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

import { fakeCommandEnv, writeFakeCommand } from "./test-support/fake-command.js";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "scripts");

// why: the script asks only for the PR's comments; the one ledger comment is its ground truth.
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "api" || !/\\/issues\\/7\\/comments$/.test(args[3])) process.exit(9);
const findings = [{ id: "R1", role: "code", class: "testing 3", outcome: "fixed", path: "src/a.ts" }];
const body = "## Review ledger\\n\\n\`\`\`json\\n" + JSON.stringify({ findings }) + "\\n\`\`\`";
process.stdout.write(JSON.stringify([{ body }]));
`;

interface Checkout {
  readonly base: string;
  readonly head: string;
  readonly later: string;
  readonly origin: string;
  readonly root: string;
  readonly work: string;
}

interface Truth {
  readonly escaped?: readonly { bug: number; fix: string; round: string }[];
  readonly findings: readonly { id: string }[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

// why: the script works on the checkout it sits in and pins on that checkout's origin, so each
// test gets both: a PR whose head adds lines 4 and 5 of src/a.ts, and a later commit on it.
function checkout(): Checkout {
  const root = mkdtempSync(join(tmpdir(), "replay-freeze-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare");
  mkdirSync(join(work, ".agents", "scripts"), { recursive: true });
  mkdirSync(join(work, "src"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "config"));
  writeFakeCommand(join(root, "bin"), "gh", FAKE_GH);
  for (const name of ["replay-freeze.mjs", "review-metrics.mjs", "transcripts.mjs", "cli-args.mjs"])
    copyFileSync(join(SCRIPTS, name), join(work, ".agents", "scripts", name));
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", origin);
  const commit = (lines: string[]): string => {
    writeFileSync(join(work, "src", "a.ts"), `${lines.join("\n")}\n`);
    git(work, "add", "src/a.ts");
    git(work, "commit", "-q", "-m", `${String(lines.length)} lines`);
    return git(work, "rev-parse", "HEAD");
  };
  const base = commit(["one", "two", "three"]);
  const head = commit(["one", "two", "three", "four", "five"]);
  const later = commit(["one", "two", "three", "four", "five", "six"]);
  git(work, "push", "-q", "origin", `${later}:refs/pull/7/head`);
  return { base, head, later, origin, root, work };
}

function freeze(at: Checkout, round: string, head: string, more: string[] = []) {
  const run = spawnSync(
    process.execPath,
    [
      join(at.work, ".agents", "scripts", "replay-freeze.mjs"),
      "--pr",
      "7",
      "--round",
      round,
      "--head",
      head,
      "--base",
      at.base,
      ...more,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...fakeCommandEnv(join(at.root, "bin")),
        CLAUDE_CONFIG_DIR: join(at.root, "config"),
        GH_REPO: "o/r",
      },
    },
  );
  return { code: run.status, err: run.stderr };
}

function escapedFile(at: Checkout, name: string, entries: object[]): string[] {
  const file = join(at.root, name);
  writeFileSync(file, JSON.stringify(entries));
  return ["--escaped", file];
}

function pinned(at: Checkout): string[] {
  return git(at.origin, "for-each-ref", "--format=%(refname)", "refs/replay").split("\n");
}

function truth(at: Checkout): Truth {
  return JSON.parse(git(at.origin, "cat-file", "-p", "refs/replay/7/truth")) as Truth;
}

const place = (start: number, end: number, file = "src/a.ts") => ({ end, file, start });

describe("replay-freeze.mjs", () => {
  it("pins the head, the base and a truth blob holding the ledger findings and each escaped bug with its fix commit and round", () => {
    const at = checkout();

    const run = freeze(
      at,
      "1",
      at.head,
      escapedFile(at, "escaped.json", [
        { bug: 31, fix: at.later.slice(0, 12), note: "why", places: [place(4, 5)] },
      ]),
    );

    expect(run).toMatchObject({ code: 0 });
    expect(pinned(at)).toEqual([
      "refs/replay/7/1/base",
      "refs/replay/7/1/head",
      "refs/replay/7/truth",
    ]);
    expect(git(at.origin, "rev-parse", "refs/replay/7/1/head")).toBe(at.head);
    expect(truth(at)).toEqual({
      escaped: [{ bug: 31, fix: at.later, note: "why", places: [place(4, 5)], round: "1" }],
      findings: [
        { class: "testing 3", id: "R1", outcome: "fixed", path: "src/a.ts", role: "code" },
      ],
      pr: 7,
    });
  });

  it("records the real review's seconds and cost as unknown, not zero, when no transcript holds a run of the round", () => {
    const at = checkout();

    freeze(at, "1", at.head);

    const snapshot = JSON.parse(
      readFileSync(join(at.work, ".agents", "replay", "7.json"), "utf8"),
    ) as { rounds: Record<string, { baseline: unknown }> };
    expect(snapshot.rounds["1"]?.baseline).toEqual({
      costUsd: null,
      lenses: [],
      runs: 0,
      seconds: null,
    });
  });

  it("refuses an escaped bug it cannot place in the reviewed diff, says why, and writes and pins nothing", () => {
    const at = checkout();
    const refused: [object, string][] = [
      [{ bug: 31, fix: at.later, places: [] }, "lacks a bug, a fix or a place"],
      [{ bug: 31, fix: "0123abc", places: [place(4, 5)] }, "fix 0123abc is not a local commit"],
      [{ bug: 31, fix: at.later, places: [place(1, 2, "src/b.ts")] }, "src/b.ts is not a file at"],
      [{ bug: 31, fix: at.later, places: [place(5, 4)] }, "needs start and end line numbers"],
      [{ bug: 31, fix: at.later, places: [place(4, 6)] }, "has 5 lines at the head, not 6"],
      [{ bug: 31, fix: at.later, places: [place(1, 3)] }, "no place overlaps a line the diff"],
    ];

    const runs = refused.map(([entry]) =>
      freeze(at, "1", at.head, escapedFile(at, "escaped.json", [entry])),
    );

    expect(runs.map((run) => run.code)).toEqual(refused.map(() => 65));
    refused.forEach(([, why], index) => expect(runs[index]?.err).toContain(why));
    expect(pinned(at)).toEqual([""]);
    expect(existsSync(join(at.work, ".agents", "replay", "7.json"))).toBe(false);
  });

  it("refuses to change a pinned truth without --replace-truth, and with it keeps the other rounds' escaped bugs", () => {
    const at = checkout();
    const first = { bug: 31, fix: at.later, places: [place(4, 5)] };
    const second = { bug: 32, fix: at.later, places: [place(6, 6)] };
    freeze(at, "1", at.head, escapedFile(at, "one.json", [first]));
    const before = git(at.origin, "rev-parse", "refs/replay/7/truth");

    const refused = freeze(at, "2", at.later, escapedFile(at, "two.json", [second]));

    expect(refused.code).toBe(65);
    expect(refused.err).toContain("run again with --replace-truth");
    expect(pinned(at)).not.toContain("refs/replay/7/2/head");
    expect(git(at.origin, "rev-parse", "refs/replay/7/truth")).toBe(before);

    const replaced = freeze(at, "2", at.later, [
      ...escapedFile(at, "two.json", [second]),
      "--replace-truth",
    ]);

    expect(replaced).toMatchObject({ code: 0 });
    expect(truth(at).escaped?.map((e) => [e.bug, e.round])).toEqual([
      [31, "1"],
      [32, "2"],
    ]);
  });

  it("keeps the pinned escaped bugs when a round is frozen again without --escaped", () => {
    const at = checkout();
    freeze(
      at,
      "1",
      at.head,
      escapedFile(at, "one.json", [{ bug: 31, fix: at.later, places: [place(4, 5)] }]),
    );
    const before = git(at.origin, "rev-parse", "refs/replay/7/truth");

    const again = freeze(at, "1", at.head);

    expect(again).toMatchObject({ code: 0 });
    expect(git(at.origin, "rev-parse", "refs/replay/7/truth")).toBe(before);
    expect(truth(at).escaped?.map((e) => e.bug)).toEqual([31]);
  });
});
