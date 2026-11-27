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
// start, 24.5 minutes of agent work in all. The orchestrator also starts issue #5, which never
// merges, and two more deliveries, by the command at 11:50 and through the Skill tool at 11:53;
// none counts for PR #7, and nor does a helper another session started. PR #1 has only a
// `pr=1 issue=1` probe run, PR #21 only a triage, and PR #8 closes #3 again a day later.
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
  reported("11:52:00", "t2"),
  reply("11:52:30", "o6", OPUS, { output_tokens: 5_000 }, [{ type: "text", text: "clean" }]),
  prompt("11:53:00", "deliver #6"),
  reply("11:53:30", "o7", OPUS, { output_tokens: 5_000 }, [
    { type: "tool_use", id: "s1", name: "Skill", input: { skill: "deliver", args: "#6" } },
  ]),
  reply("11:54:00", "o8", OPUS, { output_tokens: 5_000 }),
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
  late: {
    type: "implementer",
    id: "t8",
    lines: [
      prompt("14:00:00", `${tag("fix", "implementer", "-")}\nfixes:\n  - R1 rename it`),
      reply("14:02:00", "l1", SONNET, { output_tokens: 10_000 }),
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

type Pr = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  closes: number[];
  mergeCommit: string;
  body: string;
  files?: { path: string }[];
};
type GitHub = {
  prs: Pr[];
  issues?: { number: number; labels: string[]; createdAt: string; body: string }[];
  comments?: { issue: number; createdAt: string; body: string }[];
  pendingDecisions?: number;
};

const handoff = (blockedOn: string, done = "the PR is ready."): string =>
  `## Handoff\n\nDone: ${done}\n\nBlocked on: ${blockedOn}\n\n_Written by an agent._`;

const GITHUB: GitHub = {
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
      body: "As in #6 (Code review: 9 blocking, 9 fixed).\n\n## Review\n\nSpec review: 1 blocking, 1 fixed, 0 notes. Code review: 2 blocking, 1 fixed, 0 notes.\n\n## Notes\n\nIn #6: Claims review: 5 blocking, 5 fixed.",
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
    {
      number: 8,
      title: "feat: the flag's second half",
      headRefName: "chore/flag-again",
      baseRefName: "main",
      mergedAt: "2026-10-11T08:00:00Z",
      additions: 5,
      deletions: 0,
      changedFiles: 1,
      closes: [3],
      mergeCommit: "3333333ddddddd",
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
      createdAt: at("13:50:00"),
      body: handoff("`fast-track: #23 held: PR #25 changes 9 files, over 8.`"),
    },
    {
      issue: 23,
      createdAt: at("14:00:00"),
      body: handoff(
        "`fast-track: #23 held: PR #25 changes 300 lines, over 250.` The maintainer merges it, or the PR touches fewer lines.",
        'PR #25 touches the CLI page, changes 3 files, over 2 of them docs, and its "Decision taken" comment is withdrawn.',
      ),
    },
    {
      issue: 26,
      createdAt: at("14:10:00"),
      body: handoff(
        'fast-track: PR #27 changes 12 files, over 8; PR #27 has a "Decision taken" comment. Remove the label.',
      ),
    },
    {
      issue: 28,
      createdAt: at("14:20:00"),
      body: handoff("`fast-track: #28 held: PR #29 touches the CLI reference (website/cli.md).`"),
    },
    {
      issue: 30,
      createdAt: at("14:30:00"),
      body: handoff(
        "a slow-lane run. The fast-track: label stays; PR #31 changes 400 lines, over 250 of them tests.",
      ),
    },
    {
      issue: 32,
      createdAt: at("14:40:00"),
      body: handoff(
        "fast-track: #32 held: PR #33 is a draft: it touches docs, changes 9 files, over 8, changes 300 lines, over 250 and quotes Decision taken.",
      ),
    },
  ],
  pendingDecisions: 4,
};

type Setup = {
  log?: readonly string[];
  keptSleep?: unknown;
  files?: Record<string, string>;
  github?: GitHub;
  throughGh?: boolean;
};

function deliveryFiles(): Record<string, string> {
  const files: Record<string, string> = { "main.jsonl": `${ORCHESTRATOR.join("\n")}\n` };
  for (const [name, run] of Object.entries(RUNS)) Object.assign(files, runFiles(name, run));
  return files;
}

function runFiles(name: string, run: { type: string; id: string; lines: string[] }) {
  const file = `main/subagents/agent-${name}`;
  return {
    [`${file}.jsonl`]: `${run.lines.join("\n")}\n`,
    [`${file}.meta.json`]: JSON.stringify({ agentType: run.type, toolUseId: run.id }),
  };
}

// why: the fake answers as GitHub does, so the script's own reading of each shape is what runs:
// a search returns the rows whose day is in its range, labels are objects, a merge commit has an oid.
function fakeGh(dir: string, github: GitHub): void {
  const data = {
    prs: github.prs.map(({ closes, mergeCommit, ...pr }) => ({
      ...pr,
      files: undefined,
      closingIssuesReferences: closes.map((number) => ({ number })),
      mergeCommit: { oid: mergeCommit },
    })),
    files: Object.fromEntries(github.prs.map((pr) => [String(pr.number), pr.files ?? []])),
    issues: (github.issues ?? []).map((issue) => ({
      ...issue,
      labels: issue.labels.map((name) => ({ name })),
      updatedAt: issue.createdAt,
    })),
    comments: (github.comments ?? []).map((c) => ({
      issue_url: `https://api.github.com/repos/o/r/issues/${c.issue}`,
      created_at: c.createdAt,
      body: c.body,
    })),
    pending: github.pendingDecisions,
  };
  writeFileSync(join(dir, "gh-data.json"), JSON.stringify(data));
  writeFakeCommand(
    dir,
    "gh",
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "gh-calls.jsonl"))}, JSON.stringify(args) + "\\n");
const data = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "gh-data.json"))}, "utf8"));
const searched = (iso) => {
  const [, from, to] = /:(\\S+)\\.\\.(\\S+)$/.exec(args[args.indexOf("--search") + 1]);
  return iso.slice(0, 10) >= from && iso.slice(0, 10) <= to;
};
let out = { total_count: data.pending };
if (args[0] === "pr" && args[1] === "list") out = data.prs.filter((p) => searched(p.mergedAt));
else if (args[0] === "pr") out = { files: data.files[args[2]] };
else if (args[0] === "issue") out = data.issues.filter((i) => searched(i.updatedAt));
else if (args.some((a) => a.endsWith("/issues/comments"))) out = data.comments;
console.log(JSON.stringify(out));
`,
  );
}

function metrics(args: readonly string[], setup: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-metrics-"));
  for (const [path, text] of Object.entries(setup.files ?? deliveryFiles())) {
    const file = join(dir, "projects", "checkout", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const github = setup.github ?? GITHUB;
  const input = join(dir, "github.json");
  writeFileSync(input, JSON.stringify(github));
  if (setup.throughGh === true) fakeGh(dir, github);
  const sleepFile = join(dir, "sleep.json");
  if (setup.keptSleep !== undefined) writeFileSync(sleepFile, JSON.stringify(setup.keptSleep));
  const log = (setup.log ?? SLEPT_AFTER_THE_WORK).join("\n");
  writeFakeCommand(dir, "pmset", `#!/usr/bin/env node\nconsole.log(${JSON.stringify(log)});\n`);
  const out = execFileSync(
    process.execPath,
    [
      SCRIPT,
      ...args,
      ...(setup.throughGh === true ? ["--repo", "o/r"] : ["--input", input]),
      "--sleep",
      sleepFile,
      "--transcripts",
      join(dir, "projects", "check*"),
    ],
    { encoding: "utf8", env: { ...process.env, ...fakeCommandEnv(dir) } },
  );
  return { out, sleepFile, ghCalls: () => ghCalls(dir) };
}

// why: of a call's arguments only the query matters here: what was listed, for which days.
function ghCalls(dir: string): string[] {
  return readFileSync(join(dir, "gh-calls.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const args = JSON.parse(l) as string[];
      const what = args[0] === "api" ? ["api"] : args.slice(0, args[1] === "view" ? 3 : 2);
      const query = args.filter((arg) =>
        /^(merged:|updated:|repos\/|search\/|since=|q=)/.test(arg),
      );
      return [...what, ...query].join(" ");
    });
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

const WINDOW = ["--end", "2026-10-11T00:00:00Z", "--days", "2"];

describe("delivery-metrics.mjs", () => {
  it("adds up a PR's delivery from the runs its ledger tags name and the orchestrator's turns and tokens while that PR was its latest spawn or report, a later `deliver` by command or by Skill ending that: awake wall from the claim to the merge, minutes and USD by stage, each message once at its last usage, and what the fix and slow-lane runs report", () => {
    const { out } = metrics(["--prs", "7", "--json"]);

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
      busyMin: 24.5,
      noAgentShare: 0.72,
      afterLastAgentMin: 7.5,
      agentMin: { build: 10, "review-r1": 5, fix: 2, hardware: 5, orchestrator: 2.5 },
      agentMinTotal: 24.5,
      usd: { build: 3.4, "review-r1": 1, fix: 0.1, hardware: 0.1, orchestrator: 0.4 },
      usdTotal: 5,
      tokens: { input: 1_000_000, cacheWrite: 100_000, cacheRead: 10_000_000, output: 140_000 },
      runs: { implementer: 2, reviewer: 1, "hardware-verifier": 1 },
      runsTotal: 4,
      stageRuns: { build: 1, "review-r1": 1, fix: 1, hardware: 1 },
      reviewPasses: 1,
      slow: { starts: 1, pass: 0, fail: 1, busy: 0, unavailable: 0, unknown: 0, agentMin: 5 },
      fix: { runs: 1, ciOnly: 1, stackOnly: 0 },
      maintainerMessages: 1,
      orchestratorSessions: 1,
      findings: { raised: 3, fixed: 2 },
    });
  });

  it("gives a run tagged with an issue that two PRs close to the first of them to merge after the run started", () => {
    const { out } = metrics(["--prs", "8,7", "--json"]);

    const { prs } = JSON.parse(out) as { prs: unknown[] };
    expect(prs).toMatchObject([
      {
        pr: 8,
        issues: [3],
        claimAt: at("14:00:00"),
        wallMin: 1080,
        agentMin: { fix: 2, orchestrator: 0 },
        usdTotal: 0.1,
        runs: { implementer: 1 },
        fix: { runs: 1, ciOnly: 0, stackOnly: 0 },
        maintainerMessages: 0,
      },
      { pr: 7, issues: [3], claimAt: at("10:01:00"), runsTotal: 4, usdTotal: 5 },
    ]);
  });

  it("prints the twelve headline metrics, with no interval under five PRs, and a row per stage for the PRs merged in the window with a tagged delivery run", () => {
    const { out } = metrics(WINDOW);

    const lines = out.split("\n");
    expect(lines.slice(0, 16)).toEqual([
      "# Delivery metrics, 2026-10-09..2026-10-11: 1 delivered PRs",
      "",
      "| # | metric | value | 95% interval |",
      "| --: | --- | --- | --- |",
      "| 1 | USD per delivered PR, mean (median; S / M / L medians) | 5.00 (5.00; 5.00 / - / -) | - |",
      "| 2 | Tokens per PR, median: output / cache read / fresh input | 140k / 10.0M / 1.1M | - |",
      "| 3 | Sub-agent runs per PR, mean (median, p90) | 4 (4, 4) | - |",
      "| 4 | Review passes per PR, mean; share with a round 2; findings fixed per PR | 1.00; 0.00; 2.00 | - |",
      "| 5 | Agent-minutes per PR, median, S / M / L | 24.5 / - / - | - |",
      "| 6 | Wall claim to merge: share within 3 h; median of those (median of all) | 1.00; 89 min (89) | - |",
      "| 7 | No-agent share of wall, PRs within 3 h; last agent to merge, median | 0.72; 7.5 min | - |",
      "| 8 | Slow lane: share of PRs; starts per PR; agent-min per PR; failed starts | 1.00; 1.00; 5; 1 of 1 | - |",
      "| 9 | Typed maintainer messages per PR, mean; share of PRs with none | 1.00; 0.00 | - |",
      "| 10 | CI-only fix runs per PR, mean (runs; share of PRs) | 1.00 (1; 1.00) | - |",
      "| 11 | Bugs filed in the window's length after it, per merged PR (naming a delivered PR) | 0.33 = 1 / 3 (1) | - |",
      "| 12 | Orchestrator share of a PR's USD, median (pooled) | 0.08 (0.08) | - |",
    ]);
    expect(
      lines.slice(lines.indexOf("## By stage, over the PRs that had the stage") + 4, 27),
    ).toEqual([
      "| build | 1 | 1 | 10 / 10 | 3.40 / 3.40 | 3 | 0.60 |",
      "| review round 1 | 1 | 1 | 5 / 5 | 1.00 / 1.00 | 1 | 0.20 |",
      "| fix | 1 | 1 | 2 / 2 | 0.10 / 0.10 | 0 | 0.00 |",
      "| hardware | 1 | 1 | 5 / 5 | 0.10 / 0.10 | 0 | 0.00 |",
      "| orchestrator | 1 | - | 2.5 / 2.5 | 0.40 / 0.40 | 0 | 0.00 |",
      "",
    ]);
  });

  it("prints a metric's 95% interval once five PRs are in the window: with five PRs at $1 and one at $7, resampled means and medians run from 1 to 4; a stage none of them had gets no row", () => {
    const usd = [1, 1, 1, 1, 1, 7];
    const files = Object.assign(
      {},
      ...usd.map((dollars, i) =>
        runFiles(`p${i}`, {
          type: "implementer",
          id: `p${i}`,
          lines: [
            prompt(
              "10:00:00",
              `ledger: pr=${40 + i} issue=- stage=build round=- role=implementer lens=-`,
            ),
            reply("10:01:00", `p${i}`, SONNET, { output_tokens: dollars * 100_000 }),
          ],
        }),
      ),
    ) as Record<string, string>;
    const prs = usd.map((_, i) => ({
      number: 40 + i,
      title: "chore: one of six",
      headRefName: `chore/six-${i}`,
      baseRefName: "main",
      mergedAt: at("12:00:00"),
      additions: 10,
      deletions: 0,
      changedFiles: 1,
      closes: [],
      mergeCommit: `${i}`.repeat(10),
      body: "",
    }));

    const { out } = metrics(WINDOW, { files, github: { prs } });

    expect(tableLine(out, "1")).toBe(
      "| 1 | USD per delivered PR, mean (median; S / M / L medians) | 2.00 (1.00; 1.00 / - / -) | mean 1.00..4.00; S 1.00..4.00 |",
    );
    const lines = out.split("\n");
    expect(
      lines.slice(lines.indexOf("## By stage, over the PRs that had the stage") + 4, 24),
    ).toEqual([
      "| build | 6 | 1 | 1 / 1 | 1.00 / 4.00 | 12 | 1.00 |",
      "",
      "USD at list prices as of 2026-11-03.",
    ]);
  });

  it("counts the autonomy numbers from the issues and comments: an exit hold by the holds its quoted check line lists in the check's own words, whatever else the handoff names, the newest handoff of an issue winning", () => {
    const { out } = metrics(WINDOW);

    expect(out.slice(out.indexOf("## Autonomy")).split("\n").slice(4, 12)).toEqual([
      "| PRs merged with `fast-track` | 1 of 3 merged |",
      "| Bugs held at the fast-track entry, by `no` line | 1: One fix 1 |",
      "| PRs held at the fast-track exit, by reason | 3: lines over the limit 1, files over the limit 1, a Decision taken comment 1, a surface path 1 |",
      "| Handoffs | 6 |",
      "| Follow-up bugs, and how many name each PR merged in the 28 days before | 1: #7 1 |",
      '| Issues and PRs with a "pending the maintainer" mark, today | 4 |',
      "| Hours from bug report to `main`, median: all bug PRs | 1.5 (p90 1.5; 1 PRs) |",
      "| Hours from bug report to `main`, median: fast-tracked | 1.5 (p90 1.5; 1 PRs) |",
    ]);
  });

  it("without --input lists from GitHub the PRs merged from 28 days before the window to --days after it, a week a query, the issues updated and the comments written since the window's start and the pending marks, and prints what the same data gives through --input", () => {
    const viaGh = metrics(WINDOW, { throughGh: true });

    expect(viaGh.ghCalls()).toEqual([
      "pr list merged:2026-09-11..2026-09-17",
      "pr list merged:2026-09-18..2026-09-24",
      "pr list merged:2026-09-25..2026-10-01",
      "pr list merged:2026-10-02..2026-10-08",
      "pr list merged:2026-10-09..2026-10-15",
      "issue list updated:2026-10-09..2026-10-15",
      "api repos/o/r/issues/comments since=2026-10-09T00:00:00.000Z",
      'api search/issues q=repo:o/r "decided in delivery, pending the maintainer"',
    ]);
    expect(viaGh.out).toBe(metrics(WINDOW).out);
  });

  it("with --prs reads each named PR's changed files from GitHub for its modules", () => {
    const { out, ghCalls } = metrics([...WINDOW, "--prs", "7", "--json"], { throughGh: true });

    const { prs } = JSON.parse(out) as { prs: unknown[] };
    expect(prs).toMatchObject([{ pr: 7, modules: ["src/core", "docs"], usdTotal: 5 }]);
    expect(ghCalls().slice(5)).toEqual(["pr view 7"]);
  });

  it("takes out the sleep an earlier run recorded before the log's first line and the clock hook's lines from before the record, and keeps the record for the next run", () => {
    const keptSleep = {
      from: ms("10:16:00"),
      to: ms("10:45:00"),
      intervals: [[ms("10:16:00"), ms("10:19:00")]],
    };
    const log = [logLine("10:45:00", "Assertions"), ...SLEPT_AFTER_THE_WORK.slice(1)];

    const { out, sleepFile } = metrics(["--prs", "7", "--json"], { log, keptSleep });

    const { prs } = JSON.parse(out) as { prs: unknown[] };
    expect(prs[0]).toMatchObject({ wallMin: 84, busyMin: 24.5, afterLastAgentMin: 7.5 });
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
