/**
 * why: ADR 0087 section 4: the test files the `Unit tests (Windows)` job leaves out until a later
 * task fixes them. Sorted, repo-relative; a task takes entries off and none is ever added.
 */
const WINDOWS_SKIPPED: readonly string[] = [
  "src/budget-guard.test.ts",
  "src/ci-failures.test.ts",
  "src/claim.test.ts",
  "src/clock-hook.test.ts",
  "src/delivery-stats.test.ts",
  "src/docs-surface-check.test.ts",
  "src/fast-track.test.ts",
  "src/lint-rules.test.ts",
  "src/manual-hook.test.ts",
  "src/merge-pr.test.ts",
  "src/mutate.test.ts",
  "src/pr-body-check.test.ts",
  "src/recurring-findings.test.ts",
  "src/refactor-check.test.ts",
  "src/release-pack.test.ts",
  "src/review-inputs.test.ts",
  "src/slow-e2e.test.ts",
  "src/tool-guard.test.ts",
  "src/worktree-script.test.ts",
];

export function windowsSkipped(platform: string): readonly string[] {
  return platform === "win32" ? WINDOWS_SKIPPED : [];
}
