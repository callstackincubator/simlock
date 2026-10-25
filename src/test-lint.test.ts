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
  "test-lint.mjs",
);

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function repo(before: Record<string, string>, after: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "test-lint-"));
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

const file = (...lines: string[]) => `${lines.join("\n")}\n`;

const TIME =
  "a bound on real time goes in a *.timing.test.ts file or the slow lane; here drive a fake clock and assert the exact value (testing 5)";
const SKIP =
  "never skip, focus or defer a test to get to green; fix it or delete it, and gate a live-device test on a SIMLOCK_ variable (testing 5)";
const VACUOUS =
  "this assertion also passes on a failure; assert the exact value, or the named error and its code (testing 10)";
const INTERNAL =
  'a test of an internal file says which reason holds in a "why:" comment above its first describe (pure logic with many cases, or an ordering the surface cannot force), or tests through index.ts (testing 6)';
const BOUND =
  'bound this wire input with .max(), .length() or .regex(), or say why it needs none in a "why:" comment right above (always-in-scope 8)';

const LEASING_INDEX = { "src/leasing/index.ts": "export const leasing = 1;\n" };

describe("test-lint.mjs", () => {
  it.each([
    {
      rule: "testing 5, a real-time bound",
      before: {},
      failing: {
        "src/a/health.test.ts": file(
          "it('answers in time', () => {",
          "  const started = Date.now();",
          "  expect(Date.now() - started).toBeLessThan(2_000);",
          "});",
          "it('answers fast', () => {",
          "  const elapsed = performance.now();",
          "  expect(elapsed).toBeGreaterThan(0);",
          "});",
        ),
      },
      expected: [`src/a/health.test.ts:3: ${TIME}`, `src/a/health.test.ts:7: ${TIME}`],
      passing: {
        "src/a/health.timing.test.ts": file(
          "const started = Date.now();",
          "expect(Date.now() - started).toBeLessThan(2_000);",
        ),
        "e2e/slow-ios.test.ts": file("expect(Date.now() - started).toBeLessThan(60_000);"),
        "src/a/clock.test.ts": file(
          "const at = Date.now();",
          "clock.advance(2_000);",
          "expect(clock.now()).toBe(3_000);",
          "expect(connection.serverNow() - Date.now()).toBe(90_000);",
        ),
      },
    },
    {
      rule: "testing 5, a skipped or focused test",
      before: {},
      failing: {
        "src/a/grant.test.ts": file(
          "it.skip('grants a lease', () => {});",
          "describe.only('the queue', () => {});",
          "it.skipIf(slow)('reclaims', () => {});",
          "it.todo('releases');",
        ),
      },
      expected: [1, 2, 3, 4].map((n) => `src/a/grant.test.ts:${n}: ${SKIP}`),
      passing: {
        "src/a/live.test.ts": file(
          "const live = process.env.SIMLOCK_LIVE_ANDROID === '1' ? it : it.skip;",
          "it.skipIf(process.platform !== 'darwin')('builds on a Mac', () => {});",
        ),
        "e2e/slow-android.test.ts": file(
          "describe.skipIf(!hasAndroidSdk)('on an emulator', () => {});",
        ),
      },
    },
    {
      rule: "testing 10, an assertion a failure satisfies",
      before: {},
      failing: {
        "src/a/fail.test.ts": file(
          "expect(failure).toBeInstanceOf(Error);",
          "expect(state).not.toBe('pending');",
          "expect(recorded[0]?.()).toBe(1);",
        ),
      },
      expected: [1, 2, 3].map((n) => `src/a/fail.test.ts:${n}: ${VACUOUS}`),
      passing: {
        "src/a/fail.test.ts": file(
          "expect(failure).toMatchObject({ code: 'PROVISION_FAILED' });",
          "const answer = handlers.get('x')?.(1);",
          "expect(answer).toBe(2);",
          "await expect(",
          "  run({ onOutput: (chunk) => sink?.(chunk) }),",
          ").resolves.toBe(0);",
        ),
      },
    },
    {
      rule: "testing 6, a test of an internal file",
      before: LEASING_INDEX,
      failing: {
        "src/leasing/wait-queue.test.ts": file(
          "import { describe, it } from 'vitest';",
          "",
          "import { plan } from './wait-queue.js';",
          "",
          "describe('the wait queue', () => {",
          "  it('plans', () => plan());",
          "});",
        ),
      },
      expected: [`src/leasing/wait-queue.test.ts:3: ${INTERNAL}`],
      passing: {
        "src/leasing/planner.test.ts": file(
          "import { plan } from './planner.js';",
          "",
          "// why: pure planner, fourteen cases",
          "describe('the planner', () => {});",
        ),
        "src/leasing/index.test.ts": file(
          "import { leasing } from './index.js';",
          "import { fakeQueue } from './testing.js';",
          "import { definition } from './definition.js';",
          "import type { Queue } from './queue.js';",
          "describe('leasing', () => {});",
        ),
      },
    },
    {
      rule: "always-in-scope 8, unbounded wire input",
      before: {},
      failing: {
        "src/contract/x.ts": file(
          "export const a = z.object({",
          "  name: z.string().min(1),",
          "  tags: z.array(z.string().max(10)),",
          "  env: z.record(z.string().max(5), z.string().max(5)),",
          "});",
        ),
      },
      expected: [2, 3, 4].map((n) => `src/contract/x.ts:${n}: ${BOUND}`),
      passing: {
        "src/contract/x.ts": file(
          "export const a = z.object({",
          "  id: z.string().regex(/^[a-z]+$/),",
          "  name: z",
          "    .string()",
          "    .max(NAME_MAX)",
          "    .optional(),",
          "  tags: z.array(z.string().length(4)).max(10),",
          "  // why: the keys are the environment's own names, each value bounded",
          "  env: z.record(z.string().max(5), z.string().max(5)),",
          "});",
        ),
        "src/contract/x.test.ts": file("const loose = z.string();"),
      },
    },
  ])(
    "$rule: names the rule and what to do on each added line that breaks it, and passes the forms it allows",
    ({ before, failing, expected, passing }) => {
      expect(lint(repo(before, failing))).toEqual({ status: 1, lines: expected });
      expect(lint(repo(before, passing))).toEqual({ status: 0, lines: [] });
    },
  );

  it("judges only the lines the diff adds in the files given, and never a pattern inside a string or comment", () => {
    const dir = repo(
      { "src/a/old.test.ts": file("it.skip('old', () => {});") },
      {
        "src/a/old.test.ts": file(
          "it.skip('old', () => {});",
          "const fixture = \"it.only('x', () => {}); expect(e).toBeInstanceOf(Error);\";",
          "// it.only('commented out')",
          "const template = `${name} it.skip(`;",
        ),
        "src/a/other.test.ts": file("it.only('focused', () => {});"),
      },
    );

    expect(lint(dir, "src/a/old.test.ts")).toEqual({ status: 0, lines: [] });
    expect(lint(dir)).toEqual({ status: 1, lines: [`src/a/other.test.ts:1: ${SKIP}`] });
  });
});
