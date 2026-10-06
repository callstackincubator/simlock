import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "merge-pr.sh",
);

interface Fleet {
  /** The red check's bucket before a re-run: `fail` or `cancel`. */
  readonly bucket: "fail" | "cancel";
  /** What `gh run view --log-failed` prints for the red job. */
  readonly log: string;
  /** Bodies of the open `flaky-test` issues. */
  readonly flakyIssues: string;
  /** Whether the check passes after a re-run. */
  readonly passesOnRerun: boolean;
}

/**
 * Runs the gate on PR 7 against a fake `gh` whose one CI check, Quality (Actions run 77), is
 * red until `gh run rerun` is called. Returns the gate's exit code and output, how many times it
 * re-ran the job, and whether it merged.
 */
function gate(fleet: Fleet) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-"));
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  write("log", fleet.log);
  write("flaky", fleet.flakyIssues);
  const after = fleet.passesOnRerun ? "pass" : fleet.bucket;
  // The fake answers by the --json fields asked for; it ignores the -q filter, so each answer
  // is already in the shape the filter would print.
  write(
    "gh",
    `#!/bin/sh
d=${JSON.stringify(dir)}
state() { if [ -f "$d/reran" ]; then echo ${after}; else echo ${fleet.bucket}; fi; }
case "$*" in
  "pr view 7 --json state"*) echo OPEN ;;
  "pr view 7 --json isDraft"*) echo false ;;
  "pr view 7 --json labels"*) ;;
  "pr view 7 --json body"*) printf '## Review\\nSpec review: 0 blocking\\n' ;;
  "pr view 7 --json mergeable"*) echo MERGEABLE ;;
  "pr checks 7 --json name,bucket"*) echo "$(state) Quality" ;;
  "pr checks 7 --json bucket,link"*)
    b=$(state); [ "$b" = pass ] || echo "$b https://github.com/o/r/actions/runs/77/job/5" ;;
  "issue list --label flaky-test"*) cat "$d/flaky" ;;
  "run view 77 --log-failed") cat "$d/log" ;;
  "run rerun 77 --failed") echo rerun >>"$d/reran" ;;
  "pr merge 7 --squash") touch "$d/merged" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  let status = 0;
  let output = "";
  try {
    output = execFileSync("sh", [SCRIPT, "7"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_PR_POLL_SECONDS: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    status = failed.status;
    output = failed.stdout + failed.stderr;
  }
  return {
    status,
    output,
    reruns: existsSync(join(dir, "reran"))
      ? readFileSync(join(dir, "reran"), "utf8").trim().split("\n").length
      : 0,
    merged: existsSync(join(dir, "merged")),
  };
}

const FLAKY_LOG =
  "Quality\tQuality checks\t2026-10-06T10:00:00Z  FAIL  e2e/gateway-fast-fail.test.ts > a gateway fails fast\n" +
  "Quality\tQuality checks\t2026-10-06T10:00:00Z  ✓ e2e/lease-lifecycle.test.ts (12 tests)\n";
const FLAKY_ISSUE =
  "Fails under load on main.\nTest: `e2e/gateway-fast-fail.test.ts` > a gateway fails fast\n";

describe("merge-pr.sh re-run of red CI", () => {
  it("re-runs a job that failed only in a test an open flaky-test issue names, once, and merges when the re-run passes", () => {
    const result = gate({
      bucket: "fail",
      log: FLAKY_LOG,
      flakyIssues: FLAKY_ISSUE,
      passesOnRerun: true,
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });

  it("re-runs a job GitHub cancelled, and merges when the re-run passes", () => {
    const result = gate({ bucket: "cancel", log: "", flakyIssues: "", passesOnRerun: true });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
  });

  it("does not re-run a job that failed in a test no open flaky-test issue names, and does not merge", () => {
    const log = FLAKY_LOG.replace("e2e/gateway-fast-fail.test.ts", "e2e/doctor-drift.test.ts");
    const result = gate({ bucket: "fail", log, flakyIssues: FLAKY_ISSUE, passesOnRerun: true });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not merged: CI not green");
  });

  it("does not re-run a failed job whose log names no failed test, and does not merge", () => {
    const log =
      "Quality\tQuality checks\t2026-10-06T10:00:00Z  error TS2322: Type 'string' is not assignable\n";
    const result = gate({ bucket: "fail", log, flakyIssues: FLAKY_ISSUE, passesOnRerun: true });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
  });

  it("re-runs only once: a known flaky failure that fails again is not merged", () => {
    const result = gate({
      bucket: "fail",
      log: FLAKY_LOG,
      flakyIssues: FLAKY_ISSUE,
      passesOnRerun: false,
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
  });
});
