import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// why: the static checks read git alone, so each case is a scratch repository whose branch
// `work` makes the commits given, one per entry; a `null` text deletes the file.
function check(...steps: Record<string, string | null>[]) {
  const dir = mkdtempSync(join(tmpdir(), "refactor-check-"));
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  const apply = (files: Record<string, string | null>) => {
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
  apply({
    "src/leasing/index.ts": 'export { grant } from "./grant.js";\n',
    "src/leasing/grant.ts": "export const grant = (n: number) => n;\n",
    "src/leasing/grant.test.ts": TEST,
  });
  git("switch", "-q", "-c", "work");
  for (const step of steps) apply(step);
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--base", "base", "--head", "work", "--static"],
    { cwd: dir, encoding: "utf8" },
  );
  const lines = (s: string) => s.split("\n").filter((l) => l !== "");
  return { status: run.status, out: lines(run.stdout), err: lines(run.stderr) };
}

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
