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

interface CheckRun {
  readonly name: string;
  readonly status?: string;
  readonly conclusion: string | null;
  readonly details_url?: string | null;
}

interface Status {
  readonly context: string;
  readonly state: string;
  readonly target_url?: string | null;
}

interface Fleet {
  readonly state?: string;
  readonly draft?: boolean;
  readonly labels?: readonly string[];
  readonly body?: string | null;
  readonly mergeableAnswers?: readonly (boolean | null)[];
  readonly runs?: readonly CheckRun[];
  readonly runsAfterRerun?: readonly CheckRun[];
  readonly runReadsInProgress?: number;
  readonly statuses?: readonly Status[];
  readonly statusReadsPending?: number;
  readonly flakyIssues?: readonly { title: string; body: string; pull_request?: object }[];
  readonly failedJobLog?: string;
  readonly repoFromOrigin?: boolean;
  readonly refusedAsStacked?: boolean;
  readonly stacks?: readonly {
    open: boolean;
    pull_requests: { number: number; state: string }[];
  }[];
  readonly runsByPr?: Readonly<Record<number, readonly CheckRun[]>>;
  readonly target?: number;
}

const VALID_BODY =
  "## Review\n\nSpec review: skipped. Code review: skipped. Claims review: skipped.\n" +
  "Rounds: 0. Tokens: n/a.\n\n*Written by an agent.*\n";

const QUALITY = "https://github.com/o/r/actions/runs/77/job/5";
const run = (conclusion: string | null, name = "Quality"): CheckRun => ({
  name,
  status: "completed",
  conclusion,
  details_url: QUALITY,
});

// why: the fake answers repo-scoped REST only, as a cloud session's proxy does, and runs each
// `-q` filter through jq, so the script's own filters decide what it sees.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const d = process.env.FAKE_GH_DIR;
const fleet = JSON.parse(fs.readFileSync(d + "/fleet.json", "utf8"));
const args = process.argv.slice(2);
const fail = () => {
  process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\\n");
  process.exit(9);
};
const count = (name) => {
  const f = d + "/" + name;
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  fs.writeFileSync(f, String(n + 1));
  return n;
};
const line = args.join(" ");
if (line === "run view 77 --log-failed") {
  process.stdout.write(fleet.log);
  process.exit(0);
}
if (line === "run rerun 77 --failed") {
  fs.appendFileSync(d + "/reran", "rerun\\n");
  process.exit(0);
}
const stacked = line.match(/^stack merge (\\d+) --yes --squash$/);
if (stacked !== null) {
  fs.writeFileSync(d + "/merged", stacked[1]);
  process.exit(0);
}
if (args[0] !== "api" || args[1] !== "-X") fail();
const [method, path] = args.slice(2, 4);
const fields = {};
let filter;
for (let i = 4; i < args.length; i += 2) {
  if (args[i] === "-f") fields[args[i + 1].split("=")[0]] = args[i + 1].split("=").slice(1).join("=");
  else if (args[i] === "-q") filter = args[i + 1];
  else fail();
}
const page = (items) => {
  const p = Number(fields.page);
  if (fields.per_page !== "100" || !(p >= 1)) fail();
  return items.slice((p - 1) * 100, p * 100);
};
let value;
const pr = (path.match(/^repos\\/o\\/r\\/(?:pulls|commits)\\/(?:abc)?(\\d+)/) ?? [])[1];
if (method === "PUT" && path === "repos/o/r/pulls/" + fleet.target + "/merge" && fields.merge_method === "squash") {
  if (fleet.refusedAsStacked) {
    process.stderr.write("Pull request #" + fleet.target + " is part of a stack\\n");
    process.exit(1);
  }
  fs.writeFileSync(d + "/merged", "");
  value = { merged: true };
} else if (method !== "GET") {
  fail();
} else if (path === "repos/o/r/stacks?pull_request=" + fleet.target) {
  value = fleet.stacks;
} else if (path === "repos/o/r/pulls/" + pr) {
  const asked = filter !== undefined && filter.includes("mergeable") ? count("mergeable-reads") : 0;
  value = {
    state: fleet.state,
    draft: fleet.draft,
    labels: fleet.labels.map((name) => ({ name })),
    body: fleet.body,
    head: { ref: "chore/x", sha: "abc" + pr },
    mergeable: fleet.mergeable[Math.min(asked, fleet.mergeable.length - 1)],
  };
} else if (path === "repos/o/r/commits/abc" + pr + "/check-runs") {
  if (fields.page === "1") fs.appendFileSync(d + "/gated", pr + "\\n");
  const pending = fields.page === "1" && count("run-reads") < fleet.pendingReads;
  const runs =
    fleet.runsByPr[pr] ?? (fs.existsSync(d + "/reran") ? fleet.runsAfterRerun : fleet.runs);
  const shown = pending ? runs.map((r) => ({ ...r, status: "in_progress", conclusion: null })) : runs;
  value = { total_count: runs.length, check_runs: page(shown) };
} else if (path === "repos/o/r/commits/abc" + pr + "/status") {
  const pending = fields.page === "1" && count("status-reads") < fleet.statusPendingReads;
  const shown = pending ? fleet.statuses.map((s) => ({ ...s, state: "pending" })) : fleet.statuses;
  value = { state: "pending", statuses: page(shown) };
} else if (path === "repos/o/r/issues" && fields.labels === "flaky-test" && fields.state === "open") {
  value = fleet.flakyIssues;
} else {
  fail();
}
const json = JSON.stringify(value);
process.stdout.write(filter === undefined ? json : execFileSync("jq", ["-r", filter], { input: json, encoding: "utf8" }));
`;

function fleetFile(fleet: Fleet) {
  const f = {
    state: "open",
    draft: false,
    labels: [],
    body: VALID_BODY,
    mergeableAnswers: [true],
    runs: [run("success")],
    runReadsInProgress: 0,
    statuses: [],
    statusReadsPending: 0,
    flakyIssues: [],
    failedJobLog: "",
    refusedAsStacked: false,
    stacks: [],
    runsByPr: {},
    target: 7,
    ...fleet,
  };
  return {
    state: f.state,
    draft: f.draft,
    labels: f.labels,
    body: f.body,
    mergeable: f.mergeableAnswers,
    runs: f.runs,
    runsAfterRerun: f.runsAfterRerun ?? f.runs,
    pendingReads: f.runReadsInProgress,
    statuses: f.statuses,
    statusPendingReads: f.statusReadsPending,
    flakyIssues: f.flakyIssues,
    log: f.failedJobLog,
    refusedAsStacked: f.refusedAsStacked,
    stacks: f.stacks,
    runsByPr: f.runsByPr,
    target: f.target,
  };
}

function runScript(target: number, env: NodeJS.ProcessEnv, cwd: string | undefined) {
  try {
    const output = execFileSync("sh", [SCRIPT, String(target)], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, output: failed.stdout + failed.stderr };
  }
}

function gate(fleet: Fleet = {}) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-"));
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(fleetFile(fleet)));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_GH_DIR: dir,
    MERGE_PR_POLL_SECONDS: "0",
    GH_REPO: "o/r",
  };
  let cwd: string | undefined;
  if (fleet.repoFromOrigin === true) {
    delete env.GH_REPO;
    cwd = join(dir, "clone");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd });
  }
  const { status, output } = runScript(fleet.target ?? 7, env, cwd);
  const read = (name: string) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
  return {
    status,
    output,
    reruns: read("reran") === "" ? 0 : read("reran").trim().split("\n").length,
    mergeableReads: Number(read("mergeable-reads") || 0),
    statusReads: Number(read("status-reads") || 0),
    merged: existsSync(join(dir, "merged")),
    gated: read("gated").split("\n").filter(Boolean).map(Number),
  };
}

const FLAKY_LOG =
  "Quality\tQuality checks\t2026-10-06T10:00:00Z  FAIL  e2e/gateway-fast-fail.test.ts > a gateway fails fast\n" +
  "Quality\tQuality checks\t2026-10-06T10:00:00Z  ✓ e2e/lease-lifecycle.test.ts (12 tests)\n";
const FLAKY_ISSUE = {
  title: "Flaky: a gateway fails fast",
  body: "Fails under load on main.\nTest: `e2e/gateway-fast-fail.test.ts` > a gateway fails fast\n",
};

describe("merge-pr.sh gates on the PR", { timeout: 20_000 }, () => {
  it("merges an open, ready PR with a valid body, green CI and no conflict, through the REST merge", () => {
    const result = gate();
    expect(result.output).toContain("merged #7");
    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });

  it("takes the repo from the origin remote when GH_REPO is unset", () => {
    const result = gate({ repoFromOrigin: true });
    expect(result.merged).toBe(true);
  });

  it("does not merge a PR that is not open", () => {
    expect(gate().merged).toBe(true);
    const result = gate({ state: "closed" });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: PR #7 is not open");
  });

  it("does not merge a draft", () => {
    expect(gate({ draft: false }).merged).toBe(true);
    const result = gate({ draft: true });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: PR #7 is still a draft");
  });

  it("does not merge a PR labelled needs-hardware", () => {
    expect(gate({ labels: ["task"] }).merged).toBe(true);
    const result = gate({ labels: ["task", "needs-hardware"] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: PR #7 is labelled needs-hardware");
  });

  it("does not merge a PR whose body fails pr-body-check.mjs, before it looks at CI", () => {
    const result = gate({
      runs: [run("failure")],
      body: "## Review\n\nLooks good.\n\n*Written by an agent.*\n",
    });
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain("counts line");
    expect(result.output).toContain("fails pr-body-check.mjs");
    expect(result.output).not.toContain("CI not green");
  });

  it("does not merge a PR GitHub reports as not mergeable", () => {
    const result = gate({ mergeableAnswers: [false] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: GitHub reports PR #7 as not mergeable");
  });

  it("asks again while GitHub has not computed mergeability, and merges once it says mergeable", () => {
    const result = gate({ mergeableAnswers: [null, null, true] });
    expect(result.mergeableReads).toBe(3);
    expect(result.merged).toBe(true);
  });

  it("does not merge when mergeability is still not computed after six reads", () => {
    const result = gate({ mergeableAnswers: [null] });
    expect(result.mergeableReads).toBe(6);
    expect(result.merged).toBe(false);
    expect(result.output).toContain(
      "not merged: GitHub has not computed whether PR #7 is mergeable",
    );
  });
});

describe("merge-pr.sh reading CI", { timeout: 20_000 }, () => {
  it("does not merge a PR whose head has no check runs and no statuses", () => {
    const result = gate({ runs: [] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: PR #7 has no CI checks");
  });

  it("counts a skipped or neutral check run as green", () => {
    const result = gate({ runs: [run("success"), run("skipped", "Docs"), run("neutral", "Lint")] });
    expect(result.merged).toBe(true);
  });

  it("does not merge when a check run timed out, naming the check", () => {
    const result = gate({ runs: [run("success"), run("timed_out", "Console")] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: CI not green on PR #7: fail Console;");
  });

  it("waits for a check run in progress, and merges once it completes green", () => {
    const result = gate({ runReadsInProgress: 2 });
    expect(result.output).not.toContain("not merged");
    expect(result.merged).toBe(true);
  });

  it("reads check runs past the first page of 100: a failure on page 2 blocks the merge", () => {
    const green = Array.from({ length: 100 }, (_, i) => run("success", `Job ${i}`));
    expect(gate({ runs: green }).merged).toBe(true);
    const result = gate({ runs: [...green, run("failure", "Job 100")] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("fail Job 100");
  });

  it("does not merge when a commit status failed though every check run passed", () => {
    expect(gate({ statuses: [{ context: "ext/ci", state: "success" }] }).merged).toBe(true);
    const result = gate({ statuses: [{ context: "ext/ci", state: "error" }] });
    expect(result.merged).toBe(false);
    expect(result.output).toContain("not merged: CI not green on PR #7: fail ext/ci;");
  });

  it("waits for a pending commit status, and merges once it succeeds", () => {
    const result = gate({
      statuses: [{ context: "ext/ci", state: "success" }],
      statusReadsPending: 2,
    });
    expect(result.statusReads).toBe(3);
    expect(result.merged).toBe(true);
  });
});

describe("merge-pr.sh re-run of red CI", { timeout: 20_000 }, () => {
  it("re-runs a job that failed only in a test an open flaky-test issue names, once, and merges when the re-run passes", () => {
    const result = gate({
      runs: [run("failure")],
      runsAfterRerun: [run("success")],
      failedJobLog: FLAKY_LOG,
      flakyIssues: [FLAKY_ISSUE],
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });

  it.each([
    {
      name: "a job",
      runs: [run("cancelled")],
      runsAfterRerun: [run("success")],
    },
    {
      name: "a job, though the Quality check that needs it failed,",
      runs: [run("cancelled", "E2E (2/3)"), run("failure")],
      runsAfterRerun: [run("success", "E2E (2/3)"), run("success")],
    },
    {
      name: "a Quality check, while every job it needs passed,",
      runs: [run("success", "E2E (2/3)"), run("cancelled")],
      runsAfterRerun: [run("success", "E2E (2/3)"), run("success")],
    },
  ])(
    "re-runs $name GitHub cancelled, and merges when the re-run passes",
    ({ runs, runsAfterRerun }) => {
      const result = gate({ runs, runsAfterRerun });
      expect(result.reruns).toBe(1);
      expect(result.merged).toBe(true);
    },
  );

  it("does not count a pull request in the flaky-test list as a flaky-test issue", () => {
    const result = gate({
      runs: [run("failure")],
      runsAfterRerun: [run("success")],
      failedJobLog: FLAKY_LOG,
      flakyIssues: [{ ...FLAKY_ISSUE, pull_request: { url: "https://api.github.com/x" } }],
    });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
  });

  it("does not re-run a job that failed in a test no open flaky-test issue names, and does not merge", () => {
    const log = FLAKY_LOG.replace("e2e/gateway-fast-fail.test.ts", "e2e/doctor-drift.test.ts");
    const result = gate({
      runs: [run("failure")],
      runsAfterRerun: [run("success")],
      failedJobLog: log,
      flakyIssues: [FLAKY_ISSUE],
    });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not merged: CI not green");
  });

  it("does not re-run a failed job whose log names no failed test, and does not merge", () => {
    const log =
      "Quality\tQuality checks\t2026-10-06T10:00:00Z  error TS2322: Type 'string' is not assignable\n";
    const result = gate({
      runs: [run("failure")],
      runsAfterRerun: [run("success")],
      failedJobLog: log,
      flakyIssues: [FLAKY_ISSUE],
    });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
  });

  it("re-runs only once: a known flaky failure that fails again is not merged", () => {
    const result = gate({
      runs: [run("failure")],
      failedJobLog: FLAKY_LOG,
      flakyIssues: [FLAKY_ISSUE],
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
  });
});

describe("merge-pr.sh on a stack's last open PR", { timeout: 20_000 }, () => {
  it("merges it with gh stack merge when GitHub refuses a plain merge of a stacked PR", () => {
    expect(gate().merged).toBe(true);
    const result = gate({ refusedAsStacked: true });

    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });
});

const STACK = [
  { open: false, pull_requests: [{ number: 3, state: "closed" }] },
  { open: true, pull_requests: [11, 12, 13].map((number) => ({ number, state: "open" })) },
];
const stackRuns = (ci: Record<number, "success" | "failure">) =>
  Object.fromEntries(Object.entries(ci).map(([pr, c]) => [pr, [run(c)]]));

describe("merge-pr.sh on a stacked PR", { timeout: 20_000 }, () => {
  it("gates every PR from the bottom of the stack up to the one asked for, then merges them with gh stack merge", () => {
    const result = gate({
      target: 12,
      stacks: STACK,
      runsByPr: stackRuns({ 11: "success", 12: "success", 13: "failure" }),
    });

    expect(result.gated).toEqual([11, 12]);
    expect(result.merged).toBe(true);
    expect(result.output).toContain("merged #11 #12");
  });

  it("merges nothing when a PR below the one asked for fails a gate", () => {
    const result = gate({
      target: 12,
      stacks: STACK,
      runsByPr: stackRuns({ 11: "failure", 12: "success", 13: "success" }),
    });

    expect(result.status).toBe(1);
    expect(result.merged).toBe(false);
    expect(result.output).toContain("CI not green on PR #11");
  });
});
