#!/usr/bin/env node
// `node .agents/scripts/refactor-check.mjs --pr <m> | --base <ref> --head <ref> [--static]`: the
// evidence a refactor changed no behaviour (delivery rule 18). merge-pr.sh runs it on every PR
// from a `refactor/<n>` branch, and refuses the merge when it fails. From the merge base to the
// head it checks:
//
//   tests     every test title at the base is still at the head, pins aside, whichever file
//             holds it (`vitest list` on the test files the diff touches, unit and timing
//             projects); a title only the head has is listed for the review. A line of a test
//             file (`*.test.ts`, `test-*.ts`, `testing.ts`) the diff adds or removes, and that
//             did not move (no removed line elsewhere in the diff reads the same), fails when it
//             asserts (`expect(`, `assert`, a `.toBe...(` matcher); every other one is listed for
//             the review. It prints `Tests: <n> before, <m> after.` for the touched files.
//   surface   no path surface-paths.mjs lists changed (a surface file, the protocol version, an
//             ADR), and module-surface.mjs prints the same lines at both ends: every module's
//             index.ts exports the same names with the same declarations.
//   pins      the pins (`*.pin.test.ts`) are the first commit and nothing else is in it, none
//             is left at the head, they pass on the base with the pins added, and they pass on
//             the head with the pins put back (the final code, not only the commit before their
//             deletion).
//   mutants   `pnpm mutate <base> --touched-by <head>` on the base with the pins added leaves
//             no mutant alive; it prints `Mutation: <its last line>`.
//
// The pins, titles, surface and mutants run in detached worktrees (`worktree.sh --detach
// <commit> --prepare`), removed at the end. `--static` runs only what git can answer: the test
// lines, the surface paths and the pins' place, for a quick look and for the tests of this
// script. Each failure prints as `refactor-check: <what>` on stderr and the exit is 1; a line for
// the review prints as `refactor-check: review: <what>` on stdout. With --pr it calls
// repo-scoped REST only, as merge-pr.sh does, and fetches the PR's head and base.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { option, repository } from "./cli-args.mjs";
import { surfaceHits } from "./surface-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN = /\.pin\.test\.tsx?$/;
const TEST_FILE = /(?:\.test\.tsx?|(?:^|\/)test-[^/]+\.tsx?|(?:^|\/)testing\.ts)$/;
const LISTED = /^(?:src|ui)\/.+\.test\.tsx?$/;
const ASSERTS =
  /\bexpect\s*\(|\bassert\w*\s*[.(]|\.(?:toBe|toEqual|toStrictEqual|toMatch|toThrow|toContain|toHave)\w*\s*\(/;
const TRIVIAL = /^[\s{}()[\],;]*$/;
const SHOWN = 20;

const args = process.argv.slice(2);
const pr = option("--pr");
const quick = args.includes("--static");
if (pr === null && (option("--base") === null || option("--head") === null)) {
  console.error("usage: refactor-check.mjs --pr <m> | --base <ref> --head <ref> [--static]");
  process.exit(64);
}

const failures = [];
const reviews = [];
const git = (...a) =>
  execFileSync("git", a, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const { base, head } = pr === null ? fromRefs() : fromPull();
const commits = git("rev-list", "--reverse", "--first-parent", `${base}..${head}`)
  .split("\n")
  .filter(Boolean);
const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);

for (const { what, path } of surfaceHits(changed)) {
  failures.push(`touches ${what} (${path}); a refactor leaves it as it is`);
}
checkTestLines();
const pins = pinFiles();
checkPinPlace(pins);

const worktrees = [];
try {
  if (!quick) {
    const pinBase = pinBaseDir(pins);
    const headDir = prepare(head);
    checkTitles(pinBase, headDir);
    checkSurface(pinBase, headDir);
    checkPins(pins, pinBase, headDir);
    checkMutants(pinBase);
  }
} finally {
  for (const dir of worktrees) {
    spawnSync("git", ["worktree", "remove", "--force", dir], { stdio: "ignore" });
  }
}

for (const line of reviews) console.log(`refactor-check: review: ${line}`);
for (const line of failures) console.error(`refactor-check: ${line}`);
if (failures.length > 0) process.exit(1);
console.log("refactor-check: passes");

function fromRefs() {
  const headSha = git("rev-parse", "--verify", `${option("--head")}^{commit}`).trim();
  return { base: git("merge-base", option("--base"), headSha).trim(), head: headSha };
}

function fromPull() {
  const nwo = repository();
  const pull = JSON.parse(
    execFileSync("gh", ["api", "-X", "GET", `repos/${nwo}/pulls/${pr}`], { encoding: "utf8" }),
  );
  git("fetch", "-q", "origin", pull.base.ref, pull.head.sha);
  return { base: git("merge-base", pull.base.sha, pull.head.sha).trim(), head: pull.head.sha };
}

// why: a moved line is one some other file of the diff removes (or adds) with the same text, so
// a split that carries a test or a helper along reads as no change, as `--color-moved` shows it.
function checkTestLines() {
  const added = [];
  const removed = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of git("diff", "-U0", "--no-color", "--no-renames", base, head).split("\n")) {
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("diff --git ")) {
      file = / b\/(.+)$/.exec(line)?.[1] ?? null;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith("+")) {
      added.push({ file, line: newLine++, text: line.slice(1).trim() });
    } else if (line.startsWith("-")) {
      removed.push({ file, line: oldLine++, text: line.slice(1).trim() });
    }
  }
  const unmoved = (side, other) => {
    const pool = new Map();
    for (const l of other) pool.set(l.text, (pool.get(l.text) ?? 0) + 1);
    return side.filter((l) => {
      const left = pool.get(l.text) ?? 0;
      if (left > 0) pool.set(l.text, left - 1);
      return left === 0;
    });
  };
  const judged = (l) => l.file !== null && TEST_FILE.test(l.file) && !PIN.test(l.file);
  for (const [lines, verb] of [
    [unmoved(added, removed).filter(judged), "adds"],
    [unmoved(removed, added).filter(judged), "removes"],
  ]) {
    for (const l of lines) {
      if (ASSERTS.test(l.text)) {
        failures.push(`${l.file}:${l.line} ${verb} an assertion that did not move: ${l.text}`);
      } else if (!TRIVIAL.test(l.text)) {
        reviews.push(`${l.file}:${l.line} ${verb} a test line that did not move: ${l.text}`);
      }
    }
  }
}

function pinFiles() {
  return [
    ...new Set(
      git("log", "--format=", "--name-only", "--diff-filter=A", `${base}..${head}`)
        .split("\n")
        .filter((p) => PIN.test(p)),
    ),
  ];
}

function checkPinPlace(pins) {
  const left = git("ls-tree", "-r", "--name-only", head)
    .split("\n")
    .filter((p) => PIN.test(p));
  for (const p of left)
    failures.push(`${p} is still at the head; the last commit deletes every pin`);
  if (pins.length === 0) return;
  const first = filesOf(commits[0]);
  const others = first.filter((p) => !PIN.test(p));
  if (others.length > 0) {
    failures.push(`the first commit holds more than pins: ${others.slice(0, SHOWN).join(", ")}`);
  }
  const late = pins.filter((p) => !first.includes(p));
  if (late.length > 0) failures.push(`pins added after the first commit: ${late.join(", ")}`);
}

function filesOf(commit) {
  return git("diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    .split("\n")
    .filter(Boolean);
}

// why: the pins' text is read from the last commit that still holds them, since the head has
// deleted them by design.
function pinText(path) {
  for (const commit of [...commits].reverse()) {
    const r = spawnSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" });
    if (r.status === 0) return r.stdout;
  }
  return null;
}

function prepare(commit) {
  const dir = execFileSync(join(HERE, "worktree.sh"), ["--detach", commit, "--prepare"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
    .trim()
    .split("\n")
    .at(-1);
  worktrees.push(dir);
  return dir;
}

// why: the branch's own pin commit is used when it is one, so the implementer's mutation cache
// (keyed by that commit) serves the gate's run; otherwise the pins are committed onto the base
// in the scratch worktree.
function pinBaseDir(pins) {
  if (pins.length === 0) return prepare(base);
  const first = filesOf(commits[0]);
  if (first.length > 0 && first.every((p) => PIN.test(p))) return prepare(commits[0]);
  const dir = prepare(base);
  for (const p of pins) put(dir, p);
  const run = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  run("add", "--", ...pins);
  run(
    "-c",
    "user.name=refactor-check",
    "-c",
    "user.email=refactor-check@localhost",
    "commit",
    "--no-verify",
    "-qm",
    "test(pin): the branch's pins on its base",
  );
  return dir;
}

function put(dir, path) {
  const text = pinText(path);
  if (text === null) return;
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function pnpm(dir, argv) {
  return spawnSync("pnpm", argv, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
}

function titlesAt(dir, files) {
  const present = files.filter((f) => existsSync(join(dir, f)));
  if (present.length === 0) return [];
  const out = join(mkdtempSync(join(tmpdir(), "refactor-check-")), "list.json");
  const run = pnpm(dir, [
    "exec",
    "vitest",
    "list",
    "--project",
    "unit",
    "--project",
    "timing",
    `--json=${out}`,
    ...present,
  ]);
  if (!existsSync(out)) {
    failures.push(
      `vitest could not list the tests in ${dir}: ${(run.stderr ?? "").trim().split("\n").at(-1)}`,
    );
    return [];
  }
  return JSON.parse(readFileSync(out, "utf8")).map((t) => t.name);
}

function checkTitles(baseDir, headDir) {
  const status = git("diff", "--name-status", "-M", base, head).split("\n").filter(Boolean);
  const before = new Set();
  const after = new Set();
  for (const row of status) {
    const [kind, from, to] = row.split("\t");
    const oldPath = from;
    const newPath = to ?? from;
    if (!kind.startsWith("A") && TEST_FILE.test(oldPath) && !PIN.test(oldPath)) before.add(oldPath);
    if (!kind.startsWith("D") && TEST_FILE.test(newPath) && !PIN.test(newPath)) after.add(newPath);
  }
  for (const p of [...before, ...after].filter((p) => /\.test\.tsx?$/.test(p) && !LISTED.test(p))) {
    reviews.push(`${p} is not a unit or timing test; compare its titles by hand`);
  }
  const was = titlesAt(
    baseDir,
    [...before].filter((p) => LISTED.test(p)),
  );
  const now = titlesAt(
    headDir,
    [...after].filter((p) => LISTED.test(p)),
  );
  console.log(`Tests: ${was.length} before, ${now.length} after.`);
  const lost = minus(was, now);
  for (const t of lost.slice(0, SHOWN)) failures.push(`a test title is gone: ${t}`);
  if (lost.length > SHOWN) failures.push(`and ${lost.length - SHOWN} more test titles are gone`);
  for (const t of minus(now, was)) reviews.push(`a test title only the head has: ${t}`);
}

function minus(a, b) {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    return n === 0;
  });
}

function surfaceAt(dir) {
  const run = spawnSync(process.execPath, [join(HERE, "module-surface.mjs"), dir], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) {
    failures.push(`module-surface.mjs failed in ${dir}: ${(run.stderr ?? "").trim()}`);
    return [];
  }
  return run.stdout.split("\n").filter(Boolean);
}

function checkSurface(baseDir, headDir) {
  const was = surfaceAt(baseDir);
  const now = surfaceAt(headDir);
  const changes = [
    ...minus(was, now).map((l) => `- ${l}`),
    ...minus(now, was).map((l) => `+ ${l}`),
  ];
  for (const c of changes.slice(0, SHOWN))
    failures.push(`a module surface changed: ${c.slice(0, 300)}`);
  if (changes.length > SHOWN)
    failures.push(`and ${changes.length - SHOWN} more surface lines changed`);
}

function checkPins(pins, baseDir, headDir) {
  if (pins.length === 0) return;
  const vitest = ["exec", "vitest", "run", "--project", "unit", ...pins];
  if (pnpm(baseDir, vitest).status !== 0) failures.push("the pins fail on the base");
  for (const p of pins) put(headDir, p);
  if (pnpm(headDir, vitest).status !== 0) failures.push("the pins fail on the head");
  for (const p of pins) rmSync(join(headDir, p), { force: true });
}

function checkMutants(baseDir) {
  const run = pnpm(baseDir, ["mutate", base, "--touched-by", head]);
  const lines = (run.stdout ?? "").split("\n");
  const summary =
    lines.findLast((l) => /mutants on \d+ changed ranges; \d+ alive\./.test(l)) ??
    (lines.some((l) => /nothing to mutate/.test(l))
      ? "0 mutants on 0 changed ranges; 0 alive."
      : null);
  if (summary !== null) console.log(`Mutation: ${summary.trim()}`);
  if (run.status === 1) {
    const alive = lines.filter((l) => / (Survived|NoCoverage) /.test(l));
    failures.push(
      `mutants left alive on the lines the refactor touches: ${alive.slice(0, SHOWN).join("; ")}`,
    );
  } else if (run.status !== 0 || summary === null) {
    failures.push(`pnpm mutate failed: ${(run.stderr ?? "").trim().split("\n").at(-1)}`);
  }
}
