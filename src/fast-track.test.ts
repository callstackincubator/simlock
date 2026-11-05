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
  "fast-track.mjs",
);
const FOOTER = "*Written by an agent.*";

interface World {
  readonly state?: string;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly comments?: readonly (string | { body: string; by: string })[];
  readonly repro?: boolean;
  readonly pull?: { additions: number; deletions: number; changed_files: number };
  readonly files?: readonly string[];
  readonly prComments?: readonly string[];
}

// why: the fake answers the REST calls the script makes on issue 5 and PR 9, and records every
// call that changes a label.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const d = process.env.FAKE_GH_DIR;
const world = JSON.parse(fs.readFileSync(d + "/world.json", "utf8"));
const args = process.argv.slice(2);
const [, , method, path] = args;
const at = (/^repos\/o\/r\/(.*)$/.exec(path ?? "") ?? [])[1] ?? "";
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const missing = () => { process.stderr.write("gh: Not Found (HTTP 404)\n"); process.exit(1); };
const page = (items) => (args.includes("page=1") ? items : []);
if (method === "GET" && at === "issues/5") out({ state: world.state, labels: world.labels.map((name) => ({ name })), assignees: world.assignees.map((login) => ({ login })) });
if (method === "GET" && at === "issues/5/comments") out(page(world.comments.map((c) => (typeof c === "string" ? { body: c, author_association: "MEMBER" } : { body: c.body, author_association: c.by }))));
if (method === "GET" && at === "branches/bug/5-repro") world.repro ? out({ name: "bug/5-repro" }) : missing();
if (method === "GET" && at === "pulls/9") out(world.pull);
if (method === "GET" && at === "pulls/9/files") out(page(world.files.map((filename) => ({ filename }))));
if (method === "GET" && at === "issues/9/comments") out(page(world.prComments.map((body) => ({ body }))));
if ((method === "POST" && at === "issues/5/labels") || (method === "DELETE" && at === "issues/5/labels/bug:new")) {
  fs.appendFileSync(d + "/calls", method + " " + args.slice(4).filter((a) => a !== "-f").join(" ") + "\n");
  out([]);
}
process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\n");
process.exit(9);
`;

const report = (facts: Record<string, string> = {}) =>
  [
    "## Reproduction",
    "`src/a.test.ts` fails.",
    "## Root cause",
    "Defect: `src/a.ts:12` drops the lease.",
    "## Simplest fix",
    "Keep it.",
    "## Alternatives rejected",
    "- a — no",
    "## Risk",
    "- b",
    "## Fast track",
    ...[
      "Defect",
      "Fix tried",
      "Nothing public added or broken",
      "No ADR or rule changed",
      "One fix",
    ].map((name) => `- ${name}: ${facts[name] ?? "yes"}`),
    "",
    FOOTER,
  ].join("\n");

function fastTrack(world: World, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "fast-track-"));
  const filled = {
    state: "open",
    labels: ["bug:new"],
    assignees: [],
    comments: [report()],
    repro: true,
    pull: { additions: 60, deletions: 10, changed_files: 3 },
    files: ["src/leasing/a.ts", "src/leasing/a.test.ts"],
    prComments: [],
    ...world,
  };
  writeFileSync(join(dir, "world.json"), JSON.stringify(filled));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const result = spawnSync(process.execPath, [SCRIPT, "5", ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_DIR: dir, GH_REPO: "o/r" },
  });
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

// why: each case spawns node and a fake gh several times; under a loaded suite run the default
// five seconds is not enough.
describe("fast-track.mjs entry check", { timeout: 30_000 }, () => {
  it("moves a bug:new issue whose report says yes five times to bug:ready, labelled fast-track", () => {
    const result = fastTrack({});

    expect(result).toMatchObject({ status: 0, out: "fast-track: #5 is bug:ready\n" });
    expect(result.calls).toBe("POST labels[]=bug:ready labels[]=fast-track\nDELETE \n");
  });

  it("reads the newest report, and passes a person's comments before it and an agent's after it", () => {
    const result = fastTrack({
      comments: [
        "It also happens on Android.",
        report({ Defect: "no — a gap" }),
        `Supersedes the report above.\n\n${report()}`,
        `Opened #6 for the stale doc.\n\n${FOOTER}`,
      ],
    });

    expect(result.status).toBe(0);
  });

  it.each([
    ["a closed issue", { state: "closed" }, "the issue is closed"],
    ["a bug the maintainer already took", { labels: ["bug:ready"] }, "carries bug:ready"],
    ["an assigned issue", { assignees: ["ann"] }, "assigned to ann"],
    ["an issue with no report", { comments: [`Seen.\n\n${FOOTER}`] }, "no triage report"],
    [
      "a report written before the fast track",
      { comments: [report().replace(/## Fast track\n(?:- .*\n)+/, "")] },
      "no Fast track section",
    ],
    [
      "a report that says no once",
      { comments: [report({ "One fix": "no — agent-device could carry it" })] },
      "One fix: no — agent-device could carry it",
    ],
    [
      "a person's reply after the report",
      { comments: [report(), "Not sure about the fix."] },
      "a person commented after the report",
    ],
    [
      "a report from an account that cannot write to the repo",
      { comments: [report({ Defect: "no — a gap" }), { body: report(), by: "NONE" }] },
      "not from an account that can write to the repo",
    ],
    [
      "a comment with the agent footer from an account that cannot write to the repo",
      { comments: [report(), { body: `Looks right.\n\n${FOOTER}`, by: "CONTRIBUTOR" }] },
      "a person commented after the report",
    ],
    ["a missing reproduction branch", { repro: false }, "bug/5-repro does not exist"],
  ] satisfies [string, World, string][])("holds %s and changes no label", (_, world, why) => {
    const result = fastTrack(world);

    expect(result.status).toBe(1);
    expect(result.out).toContain("fast-track: #5 held:");
    expect(result.out).toContain(why);
    expect(result.calls).toBe("");
  });
});

describe("fast-track.mjs exit check", { timeout: 30_000 }, () => {
  const tracked = { labels: ["bug:ready", "fast-track"] };

  it("passes a small fix of a fast-tracked bug", () => {
    expect(fastTrack(tracked, "--pr", "9")).toMatchObject({
      status: 0,
      out: "fast-track: #5 PR #9 passes the exit check\n",
    });
  });

  it("checks nothing on a bug the maintainer set ready", () => {
    const result = fastTrack(
      { labels: ["bug:ready"], pull: { additions: 900, deletions: 0, changed_files: 30 } },
      "--pr",
      "9",
    );

    expect(result).toMatchObject({ status: 0 });
    expect(result.out).toContain("was not fast-tracked");
  });

  it.each([
    [
      "over the line limit",
      { pull: { additions: 200, deletions: 51, changed_files: 3 } },
      "changes 251 lines, over 250",
    ],
    [
      "over the file limit",
      { pull: { additions: 10, deletions: 0, changed_files: 9 } },
      "changes 9 files, over 8",
    ],
    ["that touches the CLI tree", { files: ["src/cli/tree.ts"] }, "a surface file"],
    ["that touches an HTTP source file", { files: ["src/http/app.ts"] }, "a surface file"],
    ["that bumps the protocol", { files: ["src/contract/protocol.ts"] }, "the protocol version"],
    ["that changes an ADR", { files: ["docs/internal/adr/0005-x.md"] }, "an ADR"],
    [
      "with a decision taken in delivery",
      { prComments: [`## Decision taken\n\n**Question:** x\n\n${FOOTER}`] },
      'has a "Decision taken" comment',
    ],
  ] satisfies [string, World, string][])("holds a fast-tracked fix %s", (_, world, why) => {
    const result = fastTrack({ ...tracked, ...world }, "--pr", "9");

    expect(result.status).toBe(1);
    expect(result.out).toContain(why);
    expect(result.out).toContain("Remove the fast-track label from #5");
  });

  it("does not hold a fix for an HTTP test file", () => {
    expect(fastTrack({ ...tracked, files: ["src/http/app.test.ts"] }, "--pr", "9").status).toBe(0);
  });
});
