import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "refactor-check.mjs",
);

const TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { grant } from "./index.js";',
  'describe("grant", () => {',
  '  it("grants one lease", () => {',
  "    expect(grant(1)).toBe(1);",
  "  });",
  "});",
  "",
].join("\n");

type Step = Record<string, string | null>;

const BASE: Step = {
  "src/leasing/index.ts": 'export { grant } from "./grant.js";\n',
  "src/leasing/grant.ts": "export const grant = (n: number) => n;\n",
  "src/leasing/rule.ts": "export const limit = 3;\n",
  "src/leasing/grant.test.ts": TEST,
};

// why: each case is a scratch repository: `base` holds BASE, and branch `work` makes the commits
// given, one per step; a `null` text deletes the file.
function scratch(...steps: Step[]) {
  const dir = mkdtempSync(join(tmpdir(), "refactor-check-"));
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
  const apply = (files: Step) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(dir, path));
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
    git("add", "-A");
    git("commit", "-q", "-m", "step");
  };
  git("init", "-q", "-b", "base");
  apply(BASE);
  git("switch", "-q", "-c", "work");
  for (const step of steps) apply(step);
  return { dir, git, apply };
}

const lines = (s: string) => s.split("\n").filter((l) => l !== "");

function check(...steps: Step[]) {
  const { dir } = scratch(...steps);
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--base", "base", "--head", "work", "--static"],
    { cwd: dir, encoding: "utf8" },
  );
  return { status: run.status, out: lines(run.stdout), err: lines(run.stderr) };
}

// why: the full run prepares worktrees, lists tests, emits declarations and mutates. The script
// and its neighbours run from a copy whose worktree.sh links a node_modules holding a fake tsc
// (it copies each source file as its declaration), and a fake pnpm answers `vitest list` from
// the `it("...")` titles, `vitest run` from each pin's `// pins: <path> contains <text>` lines,
// and `mutate` with FAKE_MUTATE_OUT and FAKE_MUTATE_CODE, logging its arguments, the parent of
// the commit it runs on and the pins that commit tracks.
const SCRIPTS = ["refactor-check.mjs", "module-surface.mjs", "surface-paths.mjs", "cli-args.mjs"];
const FAKE_WORKTREE = `#!/bin/sh
dir=$(mktemp -d "\${TMPDIR:-/tmp}/wt.XXXXXX"); rmdir "$dir"
git worktree add -q --detach "$dir" "$2" >&2
ln -s "$FAKE_NODE_MODULES" "$dir/node_modules"
echo "$dir"
`;
const FAKE_TSC = String.raw`#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path"); const { execFileSync } = require("node:child_process");
const out = process.argv[process.argv.indexOf("--outDir") + 1];
for (const f of execFileSync("git", ["ls-files", "src"], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
  const to = path.join(out, f.slice(4).replace(/\.ts$/, ".d.ts"));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(f, to);
}
`;
const FAKE_PNPM = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const files = args.filter((a) => a.endsWith(".ts"));
if (args[0] === "mutate") {
  const git = (...a) => require("node:child_process").spawnSync("git", a, { encoding: "utf8" }).stdout.trim() || "none";
  const pins = git("ls-files", "*.pin.test.ts").split("\n").filter(Boolean).join(",") || "no pins";
  fs.appendFileSync(process.env.FAKE_LOG, args.join(" ") + " on " + git("rev-parse", "HEAD^") + " with " + pins + "\n");
  process.stdout.write((process.env.FAKE_MUTATE_OUT || "0 mutants on 0 changed ranges; 0 alive.") + "\n");
  process.exit(Number(process.env.FAKE_MUTATE_CODE || 0));
}
if (args[2] === "list") {
  const names = files.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/\bit\("([^"]+)"/g)].map((m) => ({ name: m[1] })));
  fs.writeFileSync(args.find((a) => a.startsWith("--json=")).slice(7), JSON.stringify(names));
  process.exit(0);
}
const pinned = files.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/^\/\/ pins: (\S+) contains (.+)$/gm)]);
process.exit(pinned.every(([, p, text]) => fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(text)) ? 0 : 1);
`;

function fullRun(dir: string, env: Record<string, string> = {}) {
  const kit = mkdtempSync(join(tmpdir(), "refactor-kit-"));
  const scripts = join(kit, ".agents", "scripts");
  const bin = join(kit, "bin");
  const modules = join(kit, "node_modules", ".bin");
  for (const d of [scripts, bin, modules]) mkdirSync(d, { recursive: true });
  for (const f of SCRIPTS) copyFileSync(join(dirname(SCRIPT), f), join(scripts, f));
  const tool = (path: string, text: string) => {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  };
  tool(join(scripts, "worktree.sh"), FAKE_WORKTREE);
  tool(join(modules, "tsc"), FAKE_TSC);
  tool(join(bin, "pnpm"), FAKE_PNPM);
  const log = join(kit, "pnpm.log");
  const run = spawnSync(
    process.execPath,
    [join(scripts, "refactor-check.mjs"), "--base", "base", "--head", "work"],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        FAKE_NODE_MODULES: join(kit, "node_modules"),
        FAKE_LOG: log,
        ...env,
      },
    },
  );
  const mutateRuns = existsSync(log) ? lines(readFileSync(log, "utf8")) : [];
  return { status: run.status, out: lines(run.stdout), err: lines(run.stderr), mutateRuns };
}

const PIN = (text: string) =>
  `// pins: src/leasing/rule.ts contains ${text}\nimport { it } from "vitest";\nit("keeps the limit", () => {});\n`;
const SPLIT: Step = {
  "src/leasing/grant.test.ts": null,
  "src/leasing/leases.test.ts": TEST,
  "src/leasing/grant.ts": null,
  "src/leasing/leases.ts": "export const grant = (n: number) => n;\n",
  "src/leasing/index.ts": 'export { grant } from "./leases.js";\n',
};
const UNPIN: Step = { "src/leasing/rule.pin.test.ts": null };

describe("refactor-check.mjs", { timeout: 60_000 }, () => {
  it("passes a split whose pins hold on both ends, mutates on the base with the pins, and prints the test counts and the mutation line", () => {
    const { dir, git } = scratch(
      { "src/leasing/rule.pin.test.ts": PIN("limit = 3") },
      SPLIT,
      UNPIN,
    );

    const result = fullRun(dir);

    expect(result.out).toEqual([
      "Tests: 1 before, 1 after.",
      "Mutation: 0 mutants on 0 changed ranges; 0 alive.",
      "refactor-check: passes",
    ]);
    expect(result.mutateRuns).toEqual([
      `mutate ${git("rev-parse", "base")} --touched-by ${git("rev-parse", "work")} on ${git("rev-parse", "base")} with src/leasing/rule.pin.test.ts`,
    ]);
    expect(result.status).toBe(0);
  });

  it.each([
    [
      "a test title the head lost",
      [{ "src/leasing/grant.test.ts": TEST.replace("grants one lease", "grants a lease") }],
      "refactor-check: a test title is gone: grants one lease",
    ],
    [
      "a module export whose declaration changed",
      [{ "src/leasing/grant.ts": "export const grant = (n: number, m = 0) => n + m;\n" }],
      "refactor-check: a module surface changed: - src/leasing/index.ts grant: const grant = (n: number) => n",
    ],
    [
      "pins the head breaks",
      [
        { "src/leasing/rule.pin.test.ts": PIN("limit = 3") },
        { "src/leasing/rule.ts": "export const limit = 4;\n" },
        UNPIN,
      ],
      "refactor-check: the pins fail on the head",
    ],
    [
      "pins that fail on the base",
      [
        { "src/leasing/rule.pin.test.ts": PIN("limit = 4") },
        { "src/leasing/rule.ts": "export const limit = 4;\n" },
        UNPIN,
      ],
      "refactor-check: the pins fail on the base",
    ],
  ])("fails %s", (_, steps, expected) => {
    const result = fullRun(scratch(...steps).dir);

    expect(result.err).toContain(expected);
    expect(result.status).toBe(1);
  });

  it("fails a mutant the mutation run left alive, naming it", () => {
    const result = fullRun(scratch(SPLIT).dir, {
      FAKE_MUTATE_OUT:
        "src/leasing/grant.ts:1 Survived ArrowFunction: () => undefined\n\n1 mutants on 1 changed ranges; 1 alive.",
      FAKE_MUTATE_CODE: "1",
    });

    expect(result.out).toContain("Mutation: 1 mutants on 1 changed ranges; 1 alive.");
    expect(result.err).toContain(
      "refactor-check: mutants left alive on the lines the refactor touches: src/leasing/grant.ts:1 Survived ArrowFunction: () => undefined",
    );
    expect(result.status).toBe(1);
  });

  it("judges only the refactor after the base branch moved and was merged in, running the pins on the new merge base", () => {
    const { dir, git, apply } = scratch({ "src/leasing/rule.pin.test.ts": PIN("limit = 3") });
    git("switch", "-q", "base");
    apply({
      "src/leasing/rule.ts": "export const limit = 3;\nexport const spare = 1;\n",
      "src/leasing/grant.test.ts": TEST.replace("toBe(1)", "toBe(n)"),
      "src/leasing/index.ts":
        'export { grant } from "./grant.js";\nexport { spare } from "./rule.js";\n',
    });
    git("switch", "-q", "work");
    git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", "base");
    apply({
      ...SPLIT,
      "src/leasing/leases.test.ts": TEST.replace("toBe(1)", "toBe(n)"),
      "src/leasing/index.ts":
        'export { grant } from "./leases.js";\nexport { spare } from "./rule.js";\n',
    });
    apply(UNPIN);

    const result = fullRun(dir);

    expect(result.err).toEqual([]);
    expect(result.mutateRuns).toEqual([
      `mutate ${git("rev-parse", "base")} --touched-by ${git("rev-parse", "work")} on ${git("rev-parse", "base")} with src/leasing/rule.pin.test.ts`,
    ]);
    expect(result.status).toBe(0);
  });
});

describe("refactor-check.mjs --static", () => {
  it("passes a split that moves a test and its code to new files, with no line for the review", () => {
    expect(
      check({
        "src/leasing/grant.test.ts": null,
        "src/leasing/leases.test.ts": TEST,
        "src/leasing/grant.ts": null,
        "src/leasing/leases.ts": "export const grant = (n: number) => n;\n",
        "src/leasing/index.ts": 'export { grant } from "./leases.js";\n',
      }),
    ).toEqual({ status: 0, out: ["refactor-check: passes"], err: [] });
  });

  it("fails an assertion that changed and did not move, naming both sides", () => {
    const result = check({
      "src/leasing/grant.test.ts": TEST.replace("toBe(1)", "toBe(2)"),
    });

    expect(result.err).toEqual([
      "refactor-check: src/leasing/grant.test.ts:5 adds an assertion that did not move: expect(grant(1)).toBe(2);",
      "refactor-check: src/leasing/grant.test.ts:5 removes an assertion that did not move: expect(grant(1)).toBe(1);",
    ]);
    expect(result.status).toBe(1);
  });

  it("lists a test line that changed without asserting for the review, and passes", () => {
    expect(
      check({
        "src/leasing/grant.test.ts": TEST.replace('"./index.js"', '"../leasing/index.js"'),
      }),
    ).toEqual({
      status: 0,
      out: [
        'refactor-check: review: src/leasing/grant.test.ts:2 adds a test line that did not move: import { grant } from "../leasing/index.js";',
        'refactor-check: review: src/leasing/grant.test.ts:2 removes a test line that did not move: import { grant } from "./index.js";',
        "refactor-check: passes",
      ],
      err: [],
    });
  });

  it("passes pins that are the first commit alone and are deleted by the last", () => {
    const pin = TEST.replace("grants one lease", "grants two");
    expect(
      check(
        { "src/leasing/grant.pin.test.ts": pin },
        { "src/leasing/grant.ts": "export const grant = (n: number): number => n;\n" },
        { "src/leasing/grant.pin.test.ts": null },
      ).status,
    ).toBe(0);
  });

  it.each([
    [
      "a pin left at the head",
      [{ "src/leasing/grant.pin.test.ts": TEST }],
      "refactor-check: src/leasing/grant.pin.test.ts is still at the head; the last commit deletes every pin",
    ],
    [
      "a first commit with code beside the pins",
      [
        {
          "src/leasing/grant.pin.test.ts": TEST,
          "src/leasing/grant.ts": "export const grant = 1;\n",
        },
        { "src/leasing/grant.pin.test.ts": null },
      ],
      "refactor-check: the first commit holds more than pins: src/leasing/grant.ts",
    ],
    [
      "a pin added after the first commit",
      [
        { "src/leasing/grant.ts": "export const grant = (n: number): number => n;\n" },
        { "src/leasing/late.pin.test.ts": TEST },
        { "src/leasing/late.pin.test.ts": null },
      ],
      "refactor-check: pins added after the first commit: src/leasing/late.pin.test.ts",
    ],
    [
      "a pin edited after the first commit",
      [
        { "src/leasing/grant.pin.test.ts": TEST },
        { "src/leasing/grant.pin.test.ts": TEST.replace("toBe(1)", "toBe(2)") },
        { "src/leasing/grant.pin.test.ts": null },
      ],
      "refactor-check: pins edited after the first commit: src/leasing/grant.pin.test.ts; later commits only delete one",
    ],
    [
      "a surface file",
      [{ "src/bus/index.ts": "export interface EventMap {}\n" }],
      "refactor-check: touches a surface file (src/bus/index.ts); a refactor leaves it as it is",
    ],
    [
      "an ADR",
      [{ "docs/internal/adr/0099-x.md": "# 99\n" }],
      "refactor-check: touches an ADR (docs/internal/adr/0099-x.md); a refactor leaves it as it is",
    ],
  ])("fails %s", (_, steps, expected) => {
    const result = check(...steps);

    expect(result.err).toContain(expected);
    expect(result.status).toBe(1);
  });
});
