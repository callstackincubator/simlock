import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestCase } from "vitest/node";

import ProgressReporter from "./progress-reporter.js";

function testCase(state: "passed" | "failed", message?: string): TestCase {
  return {
    id: `case-${state}`,
    fullName: "lease > ends on release",
    module: { moduleId: join(process.cwd(), "e2e", "slow-x.test.ts") },
    result: () => ({
      state,
      errors: message === undefined ? undefined : [{ message }],
    }),
  } as unknown as TestCase;
}

function printed(run: () => void): string[] {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  run();
  return write.mock.calls.map(([chunk]) => String(chunk).replace(/^\S+ /, "").trimEnd());
}

describe("progress reporter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a START line when a test begins and an END line with its state when it ends", () => {
    const reporter = new ProgressReporter();
    const lines = printed(() => {
      reporter.onTestCaseReady(testCase("passed"));
      reporter.onTestCaseResult(testCase("passed"));
    });

    expect(lines).toEqual([
      "SLOW START e2e/slow-x.test.ts > lease > ends on release",
      "SLOW END passed 0s e2e/slow-x.test.ts > lease > ends on release",
    ]);
  });

  it("prints the first line of a failed test's first error after its END line", () => {
    const reporter = new ProgressReporter();
    const lines = printed(() => {
      reporter.onTestCaseReady(testCase("failed"));
      reporter.onTestCaseResult(testCase("failed", "waitFor timed out after 330000ms\nstack"));
    });

    expect(lines.slice(1)).toEqual([
      "SLOW END failed 0s e2e/slow-x.test.ts > lease > ends on release",
      "SLOW ERROR waitFor timed out after 330000ms",
    ]);
  });
});
