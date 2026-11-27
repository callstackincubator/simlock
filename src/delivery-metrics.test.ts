import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fakeCommandEnv, writeFakeCommand } from "./test-support/fake-command.js";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "delivery-metrics.mjs",
);
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

const at = (time: string): string => `2026-10-10T${time}.000Z`;
const ms = (time: string): number => Date.parse(at(time));
const line = (record: Record<string, unknown>, time: string): string =>
  JSON.stringify({ ...record, timestamp: at(time) });
const prompt = (time: string, text: string): string =>
  line({ type: "user", message: { content: text } }, time);
const reply = (
  time: string,
  id: string,
  model: string,
  usage: Record<string, unknown>,
  content: unknown[] = [],
): string => line({ type: "assistant", message: { id, model, usage, content } }, time);
const spawn = (id: string, type: string, text: string): Record<string, unknown> => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { subagent_type: type, prompt: text },
});
const reported = (time: string, id: string): string =>
  prompt(time, `<task-notification><tool-use-id>${id}</tool-use-id></task-notification>`);
const clockLine = (time: string, minutes: number): string =>
  line(
    {
      type: "attachment",
      attachment: {
        type: "hook_additional_context",
        content: `The computer slept ${minutes} min since the last tool call, ${minutes} min this session.`,
      },
    },
    time,
  );
const tag = (stage: string, role: string, pr = "7"): string =>
  `ledger: pr=${pr} issue=3 stage=${stage} round=1 role=${role} lens=-`;

// why: every number the tests expect follows from these times: issue #3 claimed at 10:01 and
// merged as PR #7 at 12:00, with a build, a review round, a CI-only fix and a failed slow-lane
// start, 24 minutes of agent work in all. The orchestrator also starts issue #5, which never
// merges, and a second delivery at 11:50; neither counts for PR #7, and nor does a helper
// another session started. PR #1 has only a `pr=1 issue=1` probe run, and PR #21 only a triage.
const ORCHESTRATOR = [
  prompt("10:00:00", "<command-name>/deliver</command-name><command-args>#3</command-args>"),
  reply("10:00:30", "o1", OPUS, { output_tokens: 10_000 }),
  reply("10:01:00", "o2", OPUS, { output_tokens: 5_000 }, [
    { type: "tool_use", id: "c1", name: "Bash", input: { command: "node claim.mjs 3" } },
    spawn("t1", "implementer", `${tag("build", "implementer", "-")}\nbuild it`),
  ]),
  reply("10:01:30", "o2b", OPUS, { output_tokens: 1_000 }, [
    spawn("t9", "implementer", "ledger: pr=- issue=5 stage=build round=- role=implementer lens=-"),
  ]),
  clockLine("10:15:30", 2),
  reported("10:20:00", "t1"),
  reply("10:21:00", "o3", OPUS, { output_tokens: 5_000 }, [{ type: "text", text: "built" }]),
  reply("10:21:00", "o3b", OPUS, { output_tokens: 0 }, [
    spawn("t2", "reviewer", `${tag("review", "reviewer")}\nreview it`),
  ]),
  prompt("10:40:00", "also rename the flag"),
  reply("10:41:00", "o4", OPUS, { output_tokens: 5_000 }),
  prompt("10:45:00", "Update on pull request #7: checks passed"),
  clockLine("11:45:30", 10),
  prompt("11:50:00", "<command-name>/deliver</command-name><command-args>#5</command-args>"),
  reply("11:51:00", "o5", OPUS, { output_tokens: 5_000 }),
];
const RUNS: Record<string, { type: string; id: string; lines: string[] }> = {
  build: {
    type: "implementer",
    id: "t1",
    lines: [
      prompt("10:02:00", `${tag("build", "implementer", "-")}\nbuild it`),
      reply("10:06:00", "b1", SONNET, { input_tokens: 1_000_000, output_tokens: 50_000 }),
      reply("10:12:00", "b1", SONNET, {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100_000 },
      }),
    ],
  },
  review: {
    type: "reviewer",
    id: "t2",
    lines: [
      prompt("10:22:00", `${tag("review", "reviewer")}\nreview it`),
      reply("10:27:00", "r1", SONNET, { cache_read_input_tokens: 10_000_000 }),
    ],
  },
  fix: {
    type: "implementer",
    id: "t3",
    lines: [
      prompt(
        "10:30:00",
        `${tag("fix", "implementer")}\nmerge-base: abc123\nfixes:\n  - ci: the unit job fails\nbrief: fix it`,
      ),
      reply("10:32:00", "f1", SONNET, { output_tokens: 10_000 }),
    ],
  },
  hardware: {
    type: "hardware-verifier",
    id: "t4",
    lines: [
      prompt("10:50:00", `${tag("hardware", "hardware-verifier")}\nrun the line`),
      reply("10:55:00", "h1", SONNET, { output_tokens: 10_000 }, [
        { type: "text", text: "Hardware: fail\nthe boot timed out" },
      ]),
    ],
  },
  triage: {
    type: "bug-triager",
    id: "t6",
    lines: [
      prompt("09:00:00", "issue: #20\ntriage it"),
      reply("09:10:00", "g1", OPUS, { output_tokens: 10_000 }),
    ],
  },
  probe: {
    type: "reviewer",
    id: "t7",
    lines: [
      prompt("10:03:00", "ledger: pr=1 issue=1 stage=review round=1 role=reviewer lens=-\nok"),
      reply("10:04:00", "p1", SONNET, { output_tokens: 900_000 }),
    ],
  },
  helper: {
    type: "general-purpose",
    id: "started-by-another-session",
    lines: [
      prompt("10:03:00", "pr: #7\nlook around"),
      reply("10:04:00", "x1", SONNET, { output_tokens: 900_000 }),
    ],
  },
  unmerged: {
    type: "implementer",
    id: "t5",
    lines: [
      prompt("10:05:00", `${tag("build", "implementer", "9")}\nbuild another`),
      reply("10:06:00", "u1", SONNET, { output_tokens: 900_000 }),
    ],
  },
};

const TRIAGE_REPORT = [
  "## Reproduction",
  "It fails on every run.",
  "## Root cause",
  "The flag is read before it is set, since 1111111aaa.",
  "## Fast track",
  "- Defect: yes",
  "- Fix tried: yes",
  "- Nothing public added or broken: yes",
  "- No ADR or rule changed: yes",
  "- One fix: no — two fixes are possible",
].join("\n");

const GITHUB = {
  prs: [
    {
      number: 7,
      title: "feat: a flag",
      headRefName: "task/3",
      baseRefName: "main",
      mergedAt: at("12:00:00"),
      additions: 60,
      deletions: 20,
      changedFiles: 3,
      closes: [3],
      mergeCommit: "1111111aaaaaaa",
      files: [{ path: "src/core/a.ts" }, { path: "src/core/b.ts" }, { path: "docs/x.md" }],
      body: "## Review\n\nSpec review: 1 blocking, 1 fixed, 0 notes. Code review: 2 blocking, 1 fixed, 0 notes.",
    },
    {
      number: 1,
      title: "chore: the first commit",
      headRefName: "chore/start",
      baseRefName: "main",
      mergedAt: at("09:00:00"),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      closes: [],
      mergeCommit: "0000000ccccccc",
      body: "",
    },
    {
      number: 21,
      title: "fix: a typo",
      headRefName: "bug/20",
      baseRefName: "main",
      mergedAt: at("09:30:00"),
      additions: 2,
      deletions: 2,
      changedFiles: 1,
      closes: [20],
      mergeCommit: "2222222bbbbbbb",
      body: "",
    },
  ],
  issues: [
    { number: 3, labels: ["task:ready"], createdAt: "2026-10-09T08:00:00Z", body: "" },
    {
      number: 20,
      labels: ["bug:ready", "fast-track"],
      createdAt: at("08:00:00"),
      body: "Seen while testing #3.",
    },
    { number: 22, labels: ["bug:new"], createdAt: at("13:00:00"), body: "It fails." },
    { number: 24, labels: ["bug:new"], createdAt: "2026-10-11T10:00:00Z", body: "After #3." },
  ],
  comments: [
    { issue: 22, createdAt: at("13:30:00"), body: TRIAGE_REPORT },
    { issue: 22, createdAt: at("13:40:00"), body: "## Root cause\n\nI think #21 did it." },
    {
      issue: 23,
      createdAt: at("14:00:00"),
      body: "## Handoff\n\nBlocked on: `fast-track: #23 held: PR #25 changes 300 lines, over 250.`",
    },
  ],
  pendingDecisions: 4,
};

function metrics(args: readonly string[], log: readonly string[], keptSleep?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-metrics-"));
  const project = join(dir, "projects", "checkout");
  mkdirSync(join(project, "main", "subagents"), { recursive: true });
  writeFileSync(join(project, "main.jsonl"), `${ORCHESTRATOR.join("\n")}\n`);
  for (const [name, run] of Object.entries(RUNS)) {
    const file = join(project, "main", "subagents", `agent-${name}`);
    writeFileSync(`${file}.jsonl`, `${run.lines.join("\n")}\n`);
    writeFileSync(`${file}.meta.json`, JSON.stringify({ agentType: run.type, toolUseId: run.id }));
  }
  const input = join(dir, "github.json");
  writeFileSync(input, JSON.stringify(GITHUB));
  const sleep = join(dir, "sleep.json");
  if (keptSleep !== undefined) writeFileSync(sleep, JSON.stringify(keptSleep));
  writeFakeCommand(
    dir,
    "pmset",
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(log.join("\n"))});\n`,
  );
  const out = execFileSync(
    process.execPath,
    [
      SCRIPT,
      ...args,
      "--input",
      input,
      "--sleep",
      sleep,
      "--transcripts",
      join(dir, "projects", "check*"),
    ],
    { encoding: "utf8", env: { ...process.env, ...fakeCommandEnv(dir) } },
  );
  return { out, sleepFile: sleep };
}

const logLine = (time: string, what: string): string =>
  `2026-10-10 ${time} +0000 ${what.padEnd(20)}\tdetail`;
const SLEPT_AFTER_THE_WORK = [
  logLine("09:00:00", "Assertions"),
  logLine("11:00:00", "Sleep"),
  logLine("11:30:00", "Wake"),
];

function tableLine(out: string, first: string): string {
  const found = out.split("\n").find((l) => l.startsWith(`| ${first} |`));
  if (found === undefined) throw new Error(`No row ${first} in:\n${out}`);
  return found;
}

describe("delivery-metrics.mjs", () => {
  it("adds up a PR's delivery from the runs its ledger tags name and the orchestrator's turns and tokens while that PR was its latest spawn or report: awake wall from the claim to the merge, minutes and USD by stage, each message once at its last usage, and what the fix and slow-lane runs report", () => {
    const { out } = metrics(["--prs", "7", "--json"], SLEPT_AFTER_THE_WORK);

    const { prs } = JSON.parse(out) as { prs: unknown[] };
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      pr: 7,
      issues: [3],
      lines: 80,
      size: "S",
      modules: ["src/core", "docs"],
      baseCommit: "abc123",
      claimAt: at("10:01:00"),
      wallMin: 89,
      busyMin: 24,
      noAgentShare: 0.73,
      afterLastAgentMin: 35,
      agentMin: { build: 10, "review-r1": 5, fix: 2, hardware: 5, orchestrator: 2 },
      agentMinTotal: 24,
      usd: { build: 3.4, "review-r1": 1, fix: 0.1, hardware: 0.1, orchestrator: 0.3 },
      usdTotal: 4.9,
      tokens: { input: 1_000_000, cacheWrite: 100_000, cacheRead: 10_000_000, output: 135_000 },
      runs: { implementer: 2, reviewer: 1, "hardware-verifier": 1 },
      runsTotal: 4,
      reviewPasses: 1,
      slow: { starts: 1, pass: 0, fail: 1, busy: 0, unavailable: 0, unknown: 0, agentMin: 5 },
      fix: { runs: 1, ciOnly: 1, stackOnly: 0 },
      maintainerMessages: 1,
      findings: { raised: 3, fixed: 2 },
    });
  });

  it("prints, for the PRs merged in the window with a tagged delivery run, the headline metrics, a row per stage, and the autonomy numbers from the issues and comments", () => {
    const { out } = metrics(["--end", "2026-10-11T00:00:00Z", "--days", "2"], SLEPT_AFTER_THE_WORK);

    expect(out.split("\n")[0]).toBe("# Delivery metrics, 2026-10-09..2026-10-11: 1 delivered PRs");
    expect(
      ["1", "3", "4", "6", "7", "8", "9", "10", "11", "12"].map((n) => tableLine(out, n)),
    ).toEqual([
      "| 1 | USD per delivered PR, mean (median; S / M / L medians) | 4.90 (4.90; 4.90 / - / -) | - |",
      "| 3 | Sub-agent runs per PR, mean (median, p90) | 4 (4, 4) | - |",
      "| 4 | Review passes per PR, mean; share with a round 2; findings fixed per PR | 1.00; 0.00; 2.00 | - |",
      "| 6 | Wall claim to merge: share within 3 h; median of those (median of all) | 1.00; 89 min (89) | - |",
      "| 7 | No-agent share of wall, PRs within 3 h; last agent to merge, median | 0.73; 35 min | - |",
      "| 8 | Slow lane: share of PRs; starts per PR; agent-min per PR; failed starts | 1.00; 1.00; 5; 1 of 1 | - |",
      "| 9 | Typed maintainer messages per PR, mean; share of PRs with none | 1.00; 0.00 | - |",
      "| 10 | CI-only fix runs per PR, mean (runs; share of PRs) | 1.00 (1; 1.00) | - |",
      "| 11 | Bugs filed in the window's length after it, per merged PR (naming a delivered PR) | 0.33 = 1 / 3 (1) | - |",
      "| 12 | Orchestrator share of a PR's USD, median (pooled) | 0.06 (0.06) | - |",
    ]);
    expect(tableLine(out, "build")).toBe("| build | 1 | 1 | 10 / 10 | 3.40 / 3.40 | 3 | 0.60 |");
    expect(tableLine(out, "orchestrator")).toBe(
      "| orchestrator | 1 | - | 2 / 2 | 0.30 / 0.30 | 0 | 0.00 |",
    );
    expect(out.slice(out.indexOf("## Autonomy")).split("\n").slice(4, 12)).toEqual([
      "| PRs merged with `fast-track` | 1 of 3 merged |",
      "| Bugs held at the fast-track entry, by `no` line | 1: One fix 1 |",
      "| PRs held at the fast-track exit, by reason | 1: lines over the limit 1 |",
      "| Handoffs | 1 |",
      "| Follow-up bugs, and how many name each PR merged in the 28 days before | 1: #7 1 |",
      '| Issues and PRs with a "pending the maintainer" mark, today | 4 |',
      "| Hours from bug report to `main`, median: all bug PRs | 1.5 (p90 1.5; 1 PRs) |",
      "| Hours from bug report to `main`, median: fast-tracked | 1.5 (p90 1.5; 1 PRs) |",
    ]);
  });

  it("takes out the sleep an earlier run recorded before the log's first line and the clock hook's lines from before the record, and keeps the record for the next run", () => {
    const kept = {
      from: ms("10:16:00"),
      to: ms("10:45:00"),
      intervals: [[ms("10:16:00"), ms("10:19:00")]],
    };
    const rotatedLog = [logLine("10:45:00", "Assertions"), ...SLEPT_AFTER_THE_WORK.slice(1)];

    const { out, sleepFile } = metrics(["--prs", "7", "--json"], rotatedLog, kept);

    const { prs } = JSON.parse(out) as { prs: unknown[] };
    expect(prs[0]).toMatchObject({ wallMin: 84, busyMin: 24, afterLastAgentMin: 35 });
    expect(JSON.parse(readFileSync(sleepFile, "utf8"))).toEqual({
      from: ms("10:16:00"),
      to: ms("11:30:00"),
      intervals: [
        [ms("10:16:00"), ms("10:19:00")],
        [ms("11:00:00"), ms("11:30:00")],
      ],
    });
  });
});
