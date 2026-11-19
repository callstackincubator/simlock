/**
 * why: ADR 0087 section 4: the test files the `Unit tests (Windows)` job leaves out until a later
 * task fixes them. Sorted, repo-relative; a task takes entries off and none is ever added.
 */
const WINDOWS_SKIPPED: readonly string[] = [];

export function windowsSkipped(platform: string): readonly string[] {
  return platform === "win32" ? WINDOWS_SKIPPED : [];
}
