import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "ci-failures.mjs",
);

interface Run {
  readonly databaseId: number;
  readonly workflowName: string;
  readonly headSha: string;
  readonly conclusion: string;
  readonly createdAt: string;
}

const ESC = "^[";
const VITEST_FAIL = `Quality\tQuality checks\t2026-10-11T09:35:23Z ${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m ${ESC}[30m${ESC}[45m e2e ${ESC}[49m${ESC}[39m e2e/a.test.ts${ESC}[2m > ${ESC}[22mstartup${ESC}[2m > ${ESC}[22mends the lease`;

function ciFailures(runs: readonly Run[], logs: Record<number, string>, jobs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ci-failures-"));
  writeFileSync(join(dir, "runs.json"), JSON.stringify(runs));
  for (const [id, log] of Object.entries(logs)) writeFileSync(join(dir, `log-${id}`), log);
  writeFileSync(
    join(dir, "jobs.json"),
    JSON.stringify({ jobs: jobs.map((name) => ({ name, conclusion: "failure" })) }),
  );
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
d=${JSON.stringify(dir)}
case "$*" in
  "pr view 7 --json headRefName") echo '{"headRefName":"task/7"}' ;;
  "run list --branch task/7 --limit 100 --json"*) cat "$d/runs.json" ;;
  "run view "*" --log-failed") [ -f "$d/log-$3" ] || { echo "HTTP 403: log download refused" >&2; exit 1; }; cat "$d/log-$3" ;;
  "run view "*" --json jobs") cat "$d/jobs.json" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const run = spawnSync(process.execPath, [SCRIPT, "7"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` },
  });
  return run.stdout + run.stderr;
}

const run = (
  databaseId: number,
  conclusion: string,
  createdAt: string,
  workflowName = "CI",
): Run => ({ databaseId, workflowName, headSha: `sha${databaseId}abcdef`, conclusion, createdAt });

describe("ci-failures.mjs", () => {
  it("prints the failed tests of an older run when every newer run of its workflow was cancelled", () => {
    const output = ciFailures(
      [run(3, "cancelled", "2026-10-11T10:00:00Z"), run(2, "failure", "2026-10-11T09:00:00Z")],
      { 2: VITEST_FAIL },
    );

    expect(output).toBe("CI run 2 at sha2abc\n  e2e/a.test.ts > startup > ends the lease\n");
  });

  it("strips colour codes that the log carries as the escape byte itself", () => {
    const output = ciFailures([run(2, "failure", "2026-10-11T09:00:00Z")], {
      2: VITEST_FAIL.replaceAll("^[", String.fromCharCode(27)),
    });

    expect(output).toBe("CI run 2 at sha2abc\n  e2e/a.test.ts > startup > ends the lease\n");
  });

  it("prints none when a newer run of the same workflow passed after the failure", () => {
    const output = ciFailures(
      [run(3, "success", "2026-10-11T10:00:00Z"), run(2, "failure", "2026-10-11T09:00:00Z")],
      { 2: VITEST_FAIL },
    );

    expect(output).toBe("none\n");
  });

  it("keeps a workflow's failure when another workflow's newer run passed", () => {
    const output = ciFailures(
      [
        run(3, "success", "2026-10-11T10:00:00Z", "Labels"),
        run(2, "failure", "2026-10-11T09:00:00Z"),
      ],
      { 2: VITEST_FAIL },
    );

    expect(output).toContain("CI run 2 at sha2abc");
  });

  it("names the failed job when the run's log names no test", () => {
    const output = ciFailures(
      [run(2, "failure", "2026-10-11T09:00:00Z")],
      { 2: "Quality\tLint\terror: unused import" },
      ["Quality"],
    );

    expect(output).toBe("CI run 2 at sha2abc\n  job Quality\n");
  });

  it("names the failed jobs and goes on when GitHub refuses the log download", () => {
    const output = ciFailures(
      [
        run(3, "failure", "2026-10-11T10:00:00Z"),
        run(2, "failure", "2026-10-11T09:00:00Z", "Labels"),
      ],
      { 2: VITEST_FAIL },
      ["Quality"],
    );

    expect(output).toBe(
      "CI run 3 at sha3abc\n  job Quality (log unavailable: HTTP 403: log download refused)\n" +
        "Labels run 2 at sha2abc\n  e2e/a.test.ts > startup > ends the lease\n",
    );
  });
});
