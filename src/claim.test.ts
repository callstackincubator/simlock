import { spawnSync } from "node:child_process";
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
  "claim.mjs",
);

interface Issue {
  readonly state?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly body?: string;
  readonly parent?: number;
}

// why: the fake answers the REST calls the script makes and records the assignment it asks for.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const d = process.env.FAKE_GH_DIR;
const world = JSON.parse(fs.readFileSync(d + "/world.json", "utf8"));
const args = process.argv.slice(2);
const out = (v) => { process.stdout.write(typeof v === "string" ? v + "\n" : JSON.stringify(v)); process.exit(0); };
if (args.join(" ") === "api user -q .login") out("me");
const [, , method, path] = args;
const m = /^repos\/o\/r\/(.*)$/.exec(path ?? "");
const at = m === null ? "" : m[1];
const issue = (n) => world.issues[n];
const shape = (n) => ({ ...issue(n), labels: (issue(n).labels ?? []).map((name) => ({ name })), assignees: (issue(n).assignees ?? []).map((login) => ({ login })) });
let r;
if (method === "GET" && (r = /^issues\/(\d+)$/.exec(at))) out(shape(r[1]));
if (method === "GET" && (r = /^issues\/(\d+)\/parent$/.exec(at))) {
  if (issue(r[1]).parent === undefined) { process.stderr.write("HTTP 404"); process.exit(1); }
  out({ number: issue(r[1]).parent });
}
if (method === "GET" && (r = /^pulls\?head=o:(\w+\/\d+)&state=open$/.exec(at))) out(world.pulls[r[1]] ?? []);
if ((method === "POST" || method === "DELETE") && (r = /^issues\/(\d+)\/assignees$/.exec(at))) {
  fs.appendFileSync(d + "/calls", method + " " + r[1] + " " + args.slice(4).join(" ") + "\n");
  out({ assignees: [...(world.raceWith ?? []), "me"].map((login) => ({ login })) });
}
process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\n");
process.exit(9);
`;

function claim(
  world: {
    issues: Record<number, Issue>;
    pulls?: Record<string, { draft: boolean }[]>;
    raceWith?: string[];
  },
  ...args: string[]
) {
  const dir = mkdtempSync(join(tmpdir(), "claim-"));
  writeFileSync(join(dir, "world.json"), JSON.stringify(world));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_DIR: dir, GH_REPO: "o/r" },
  });
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

const task = (body: string, extra: Issue = {}): Issue => ({
  state: "open",
  labels: ["task:ready"],
  body: `Part of #9.\n\n## Depends on\n\n${body}\n\n*Written by an agent.*`,
  parent: 9,
  ...extra,
});

// why: each case spawns node and a fake gh several times; under a loaded suite run the default
// five seconds is not enough, and a hang still fails within the half minute.
describe("claim.mjs", { timeout: 30_000 }, () => {
  it.each([
    ["a ready bug", { 5: { state: "open", labels: ["bug:ready"] } }, []],
    ["a bug:new issue to triage", { 5: { state: "open", labels: ["bug:new"] } }, ["--triage"]],
    ["a task with no dependency", { 5: task("none") }, []],
    [
      "a task whose dependency closed",
      { 5: task("- #4"), 4: { state: "closed", labels: ["task:ready"] } },
      [],
    ],
  ])("assigns %s to the user", (_, issues, flags) => {
    expect(claim({ issues }, "5", ...flags)).toEqual({
      status: 0,
      out: "claim: #5 assigned to me\n",
      calls: "POST 5 -f assignees[]=me\n",
    });
  });

  it("takes a task whose dependency is a reviewed task of the same feature", () => {
    const issues = { 5: task("- #4"), 4: { state: "open", labels: ["task:ready"], parent: 9 } };

    expect(claim({ issues, pulls: { "task/4": [{ draft: false }] } }, "5").status).toBe(0);
    expect(claim({ issues, pulls: { "task/4": [{ draft: true }] } }, "5").out).toContain(
      "depends on #4, which is open with no reviewed PR",
    );
    expect(
      claim(
        {
          issues: { ...issues, 4: { ...issues[4], parent: 8 } },
          pulls: { "task/4": [{ draft: false }] },
        },
        "5",
      ).out,
    ).toContain("not a task of the same feature");
  });

  it.each([
    ["a closed issue", { state: "closed", labels: ["bug:ready"] }, [], "is closed"],
    [
      "an assigned issue",
      { state: "open", labels: ["bug:ready"], assignees: ["ann"] },
      [],
      "is assigned to ann",
    ],
    [
      "a bug:new issue without --triage",
      { state: "open", labels: ["bug:new"] },
      [],
      "carries bug:new",
    ],
    [
      "a ready bug with --triage",
      { state: "open", labels: ["bug:ready"] },
      ["--triage"],
      "triage takes a bug:new",
    ],
    ["a draft task", { state: "open", labels: ["task:draft"] }, [], "carries task:draft"],
    [
      "a planned feature",
      { state: "open", labels: ["feature:planned"] },
      [],
      "carries feature:planned",
    ],
  ])("refuses %s and assigns nobody", (_, issue, flags, reason) => {
    const result = claim({ issues: { 5: issue } }, "5", ...flags);

    expect(result.status).toBe(1);
    expect(result.out).toContain(reason);
    expect(result.calls).toBe("");
  });

  it("gives the issue back when someone else claimed it at the same moment", () => {
    const result = claim(
      { issues: { 5: { state: "open", labels: ["bug:ready"] } }, raceWith: ["ann"] },
      "5",
    );

    expect(result.status).toBe(1);
    expect(result.out).toContain("was claimed by ann at the same moment");
    expect(result.calls).toBe("POST 5 -f assignees[]=me\nDELETE 5 -f assignees[]=me\n");
  });
});
