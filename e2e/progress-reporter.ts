// why: a slow-lane test can run for minutes with nothing in the log, and the default reporter
// prints a file's results only when the whole file ends; `scripts/slow-e2e.sh status` reads these
// lines to say which test is running and how many passed or failed so far.
import { relative } from "node:path";

import type { Reporter, TestCase } from "vitest/node";

function line(text: string): void {
  process.stdout.write(`${new Date().toISOString()} SLOW ${text}\n`);
}

function name(testCase: TestCase): string {
  return `${relative(process.cwd(), testCase.module.moduleId)} > ${testCase.fullName}`;
}

export default class ProgressReporter implements Reporter {
  readonly #started = new Map<string, number>();

  onTestCaseReady(testCase: TestCase): void {
    this.#started.set(testCase.id, Date.now());
    line(`START ${name(testCase)}`);
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const seconds = Math.round(
      (Date.now() - (this.#started.get(testCase.id) ?? Date.now())) / 1000,
    );
    line(`END ${result.state} ${seconds}s ${name(testCase)}`);
    const error = result.errors?.[0];
    if (error !== undefined) line(`ERROR ${String(error.message).split("\n")[0]}`);
  }
}
