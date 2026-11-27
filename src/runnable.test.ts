import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fakeCommandEnv, writeFakeCommand } from "./test-support/fake-command.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, ".agents", "scripts", "runnable.mjs");

const depends = (...numbers: number[]) =>
  `## Scope\n\nx\n\n## Depends on\n\n${numbers.map((n) => `- #${n}`).join("\n")}\n`;
const ready = (body: string, extra: object = {}) => ({ body, labels: ["task:ready"], ...extra });

function runnable(world: Record<string, unknown>) {
  const file = join(mkdtempSync(join(tmpdir(), "runnable-")), "world.json");
  writeFileSync(file, JSON.stringify(world));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "10", "--world", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

describe("runnable.mjs", () => {
  it("lists the open, ready, unassigned tasks whose dependencies are closed or have a ready PR, and says why each other one waits", () => {
    const result = runnable({
      10: { subIssues: [11, 12, 13, 14, 15, 16, 17] },
      11: ready(depends(), { state: "closed" }),
      12: ready(depends(11)),
      13: ready(depends(12), { prs: [{ number: 90, draft: false }] }),
      14: ready(depends(13)),
      15: ready(depends(16)),
      16: ready(depends(), { prs: [{ number: 91, draft: true }], assignees: ["agent"] }),
      17: { body: depends(), labels: ["task:draft"] },
    });

    expect(result).toEqual({
      status: 0,
      lines: [
        "chain 4 of 7 tasks",
        "waiting #13: on #12 (no PR)",
        "waiting #15: on #16 (PR in draft)",
        "waiting #16: assigned to agent",
        "waiting #17: labelled task:draft",
        "runnable: #12 #14",
      ],
    });
  });

  it("holds a task on an open issue of another feature, prints it as depends-outside, and notes a closed one", () => {
    const result = runnable({
      10: { subIssues: [11] },
      11: ready(depends(30, 31)),
      30: { state: "closed" },
      31: { parent: 40 },
    });

    expect(result).toEqual({
      status: 0,
      lines: [
        "N 11 Depends on: #30 is closed, so the line orders nothing; drop it",
        "N 11 Depends on: depends-outside #31 (open, feature #40)",
        "chain 1 of 1 tasks",
        "waiting #11: on #31 (open, outside this feature)",
        "runnable: none",
      ],
    });
  });

  it("fails on a Depends on number that does not exist and on a cycle", () => {
    const missing = runnable({ 10: { subIssues: [11] }, 11: ready(depends(99)) });
    const cycle = runnable({
      10: { subIssues: [11, 12] },
      11: ready(depends(12)),
      12: ready(depends(11)),
    });

    expect(missing.status).toBe(1);
    expect(missing.lines).toContain("B 11 Depends on: #99 does not exist; fix the line");
    expect(missing.lines.at(-1)).toBe("runnable: none");
    expect(cycle.status).toBe(1);
    expect(cycle.lines).toContain(
      "B 11 Depends on: a cycle: #11 → #12 → #11; drop one of its lines",
    );
    expect(cycle.lines.at(-1)).toBe("runnable: none");
  });
});

// why: the fake answers the two reads of the bug check: the open PRs over REST, as GitHub
// shapes them, and the issues over GraphQL.
const FAKE_GH = String.raw`#!/usr/bin/env node
const world = JSON.parse(require("node:fs").readFileSync(process.env.FAKE_GH_WORLD, "utf8"));
const args = process.argv.slice(2);
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[1] === "-X" && args[2] === "GET" && args[3] === "repos/o/r/pulls" && args.includes("state=open")) out(args.includes("page=1") ? world.pulls : []);
if (args[1] === "graphql") {
  const repository = {};
  for (const [, n] of args[3].matchAll(/i(\d+): issue\(/g)) {
    const issue = world.issues[n];
    repository["i" + n] = { number: Number(n), state: issue.state, body: "", labels: { nodes: issue.labels.map((name) => ({ name })) }, assignees: { nodes: issue.assignees.map((login) => ({ login })) }, parent: null, subIssues: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] } };
  }
  out({ data: { repository } });
}
process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\n");
process.exit(9);
`;

const newBug = { labels: ["bug:new"] };
const claimed = { labels: ["bug:ready"], assignees: ["ann"] };

function bugCheck(world: Record<string, unknown>) {
  const file = join(mkdtempSync(join(tmpdir(), "runnable-")), "world.json");
  writeFileSync(file, JSON.stringify(world));
  const result = spawnSync(process.execPath, [SCRIPT, "--bug", "20", "--world", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout };
}

describe("runnable.mjs --bug", () => {
  it("lets an open, unassigned bug:new run when no PR is open", () => {
    expect(bugCheck({ 20: newBug })).toEqual({ status: 0, out: "run\n" });
  });

  it("holds it on an open bug PR of this repository whose issue is open and assigned", () => {
    const result = bugCheck({
      20: newBug,
      21: claimed,
      pulls: [{ number: 30, head: "bug/21", fork: false }],
    });

    expect(result).toEqual({
      status: 1,
      out: "held: PR #30 (bug/21) is open and #21 is assigned to ann; one bug at a time, run again when it merges\n",
    });
  });

  it.each([
    [
      "a fork's draft PR whose issue is closed",
      { 21: { state: "closed" }, pulls: [{ number: 30, head: "bug/21", fork: true }] },
    ],
    [
      "a fork's PR whose issue is open and assigned",
      { 21: claimed, pulls: [{ number: 30, head: "bug/21", fork: true }] },
    ],
    [
      "a PR of this repository whose issue is closed",
      {
        21: { ...claimed, state: "closed" },
        pulls: [{ number: 30, head: "bug/21", fork: false }],
      },
    ],
    [
      "a parked PR, its issue open with no assignee",
      {
        21: { labels: ["bug:blocked", "fast-track"] },
        pulls: [{ number: 30, head: "bug/21", fork: false }],
      },
    ],
    [
      "an assigned task with an open PR",
      {
        21: { labels: ["task:ready"], assignees: ["ann"] },
        pulls: [{ number: 30, head: "task/21", fork: false }],
      },
    ],
    ["an unassigned bug:ready", { 20: { labels: ["bug:ready", "fast-track"] } }],
  ])("does not hold it on %s", (_, world) => {
    expect(bugCheck({ 20: newBug, ...world })).toEqual({ status: 0, out: "run\n" });
  });

  it.each([
    ["a closed bug", { state: "closed", labels: ["bug:new"] }, "held: #20 is closed\n"],
    ["a bug someone took", { ...newBug, assignees: ["ann"] }, "held: #20 is assigned to ann\n"],
    [
      "a blocked bug",
      { labels: ["bug:blocked", "fast-track"] },
      "held: #20 carries bug:blocked, not bug:new or bug:ready\n",
    ],
  ])("holds %s whatever else is open", (_, issue, out) => {
    expect(bugCheck({ 20: issue })).toEqual({ status: 1, out });
  });

  it(
    "reads GitHub's open PRs: a fork's and a deleted fork's hold nothing, this repository's does",
    { timeout: 30_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "runnable-gh-"));
      writeFakeCommand(dir, "gh", FAKE_GH);
      const pull = (number: number, ref: string, from: string | null) => ({
        number,
        head: { ref, repo: from === null ? null : { full_name: from } },
      });
      const check = (pulls: unknown[]) => {
        writeFileSync(
          join(dir, "world.json"),
          JSON.stringify({
            pulls,
            issues: {
              20: { state: "OPEN", labels: ["bug:new"], assignees: [] },
              21: { state: "OPEN", labels: ["bug:ready"], assignees: ["ann"] },
              22: { state: "CLOSED", labels: ["bug:new"], assignees: [] },
            },
          }),
        );
        return spawnSync(process.execPath, [SCRIPT, "--bug", "20"], {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            ...fakeCommandEnv(dir),
            FAKE_GH_WORLD: join(dir, "world.json"),
            GH_REPO: "o/r",
          },
        }).stdout;
      };

      expect(check([pull(31, "bug/22", "eve/r"), pull(32, "bug/21", null)])).toBe("run\n");
      expect(check([pull(31, "bug/22", "eve/r"), pull(33, "bug/21", "O/R")])).toMatch(
        /^held: PR #33 \(bug\/21\) is open and #21 is assigned to ann;/,
      );
    },
  );
});
