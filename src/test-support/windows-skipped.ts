/**
 * why: ADR 0087 section 4: the test files the `Unit tests (Windows)` job leaves out until a later
 * task fixes them. Sorted, repo-relative; a task takes entries off and none is ever added.
 */
const WINDOWS_SKIPPED: readonly string[] = [
  "src/agent-device/host/agent-device-supervisor-state.test.ts",
  "src/agent-device/host/install.test.ts",
  "src/agent-device/rig-ports.e2e.test.ts",
  "src/budget-guard.test.ts",
  "src/ci-failures.test.ts",
  "src/claim.test.ts",
  "src/cli/index-auto-launch-handshake.test.ts",
  "src/cli/index-daemon-service.test.ts",
  "src/cli/index-daemon-status.test.ts",
  "src/cli/index-device-config.test.ts",
  "src/cli/index-events-mcp-smoke.test.ts",
  "src/cli/index-files.test.ts",
  "src/cli/index.test.ts",
  "src/cli/passthrough.test.ts",
  "src/cli/tunnel-forward-and-emulator.test.ts",
  "src/clock-hook.test.ts",
  "src/delivery-stats.test.ts",
  "src/docs-surface-check.test.ts",
  "src/fast-track.test.ts",
  "src/instructions/setup.test.ts",
  "src/lint-rules.test.ts",
  "src/manual-hook.test.ts",
  "src/merge-pr.test.ts",
  "src/mutate.test.ts",
  "src/pr-body-check.test.ts",
  "src/recurring-findings.test.ts",
  "src/refactor-check.test.ts",
  "src/release-pack.test.ts",
  "src/review-inputs.test.ts",
  "src/simlock-client/no-core-leak.test.ts",
  "src/slow-e2e.test.ts",
  "src/tool-guard.test.ts",
  "src/updater/index.test.ts",
  "src/worktree-script.test.ts",
  "ui/src/ds/contrast.test.ts",
];

export function windowsSkipped(platform: string): readonly string[] {
  return platform === "win32" ? WINDOWS_SKIPPED : [];
}
