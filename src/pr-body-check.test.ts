import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "pr-body-check.mjs",
);

const COUNTS =
  "Spec review: 1 blocking, 1 fixed, 0 notes. Code review: skipped. Claims review: 2 blocking, 1 fixed, 1 note.";
const FOOTER = "*Written by an agent.*";

function check(body: string, ...args: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), "pr-body-")), "body.md");
  writeFileSync(file, body);
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "--body-file", file, ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "" },
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

interface GitHub {
  readonly origin?: boolean;
  // why: the directory the script's git commands run in; a case about commit ancestry gives a
  // scratch repository, since CI's unit job checks the repo out one commit deep.
  readonly cwd?: string;
  readonly comments?: readonly string[];
  // why: what each other `repos/o/r/<path>` answers; null is GitHub's 404.
  readonly routes?: Readonly<Record<string, unknown>>;
}

function fromGitHub(pull: object, options: GitHub = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-body-gh-"));
  const routes: Record<string, unknown> = { "pulls/7": pull, ...options.routes };
  // why: the comments endpoint answers only when the test says so, so a case with no
  // `comments` proves the script never asked for them (a chore branch has no ledger).
  if (options.comments !== undefined) {
    routes["issues/7/comments -f per_page=100"] = options.comments.map((body) => ({ body }));
  }
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
const routes = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(join(dir, "routes.json"))}, "utf8"));
const args = process.argv.slice(2);
const key = args.join(" ").replace(/^api -X GET repos\\/o\\/r\\//, "");
if (args[0] !== "api" || !(key in routes)) {
  process.stderr.write("fake gh: unexpected: " + args.join(" ") + "\\n");
  process.exit(9);
}
if (routes[key] === null) {
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(routes[key]));
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    GH_REPO: "o/r",
    GITHUB_ACTIONS: "",
  };
  let cwd = options.cwd;
  if (options.origin === true) {
    delete (env as { GH_REPO?: string }).GH_REPO;
    cwd = join(dir, "clone");
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd });
  }
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "7"], { cwd, encoding: "utf8", env });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

// why: an issue with no Done when, no parent and no stack, for cases about other rules.
const LONE_ISSUE = { "issues/7": { body: "" }, "issues/7/parent": null };

// why: two commits of our own, so a case about ancestry does not read this clone's history,
// which CI's unit job fetches one commit deep.
function scratchRepo(): { dir: string; head: string; older: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-body-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a"), "1\n");
  git("add", "a");
  git("commit", "-qm", "one");
  const older = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a"), "2\n");
  git("commit", "-qam", "two");
  return { dir, head: git("rev-parse", "HEAD"), older };
}

const valid = [
  "Closes #12",
  "",
  "### Status",
  "Implement: done",
  "",
  "- [x] a Done when line",
  "",
  "## Assumptions",
  "",
  "none",
  "",
  "## Review",
  "",
  COUNTS,
  "Rounds: 1. Tokens: 3.2M.",
  "Assessment: complete",
  "",
  "Rejected:",
  "",
  "- claims: a claim — the doc is right",
  "",
  FOOTER,
  "",
].join("\n");

describe("pr-body-check.mjs", { timeout: 20_000 }, () => {
  it("refuses incomplete assessment even with zero findings and allows a completed assessment", () => {
    const body = valid.replace("Assessment: complete", "Assessment: incomplete — budget exhausted");
    expect(check(body).status).toBe(1);
    expect(check(body, "--draft-ok").status).toBe(0);
    expect(check(valid).status).toBe(0);
    expect(check(valid.replace("Assessment: complete\n", ""), "--branch", "task/12").lines).toEqual(
      [expect.stringContaining("no `Assessment: complete` line")],
    );
  });

  it("accepts a body with the counts line, a tagged Rejected line and the footer, without a word", () => {
    expect(check(valid, "--branch", "task/12")).toEqual({ status: 0, lines: [] });
  });

  it("fails a body without the footer, or whose Review section does not start with the counts line", () => {
    const result = check(`## Review\n\nLooks good.\n`);

    expect(result.status).toBe(1);
    expect(result.lines).toEqual([
      expect.stringContaining(
        'warning: the `## Review` section has no "Rounds: <n>. Tokens: <n>M." line',
      ),
      expect.stringContaining('the last line is not "*Written by an agent.*"'),
      expect.stringContaining("does not start with the counts line"),
    ]);
  });

  it("fails on a Rejected line with no review tag, and on 'spec needs' outside a code block only", () => {
    const untagged = valid.replace("- claims: a claim", "- a claim");
    expect(check(untagged).lines).toEqual([
      expect.stringContaining("a Rejected line is not tagged"),
    ]);

    const fenced = valid.replace("Implement: done", "Implement: done\n```\nspec needs: x\n```");
    expect(check(fenced).status).toBe(0);

    const open = valid.replace("Implement: done", "Implement: done. Spec needs: a line.");
    expect(check(open).lines).toEqual([expect.stringContaining('the body says "spec needs"')]);
  });

  it("requires the Status and Assumptions sections on a <kind>/<n> branch, and on no other", () => {
    const bare = `## Review\n\n${COUNTS}\nRounds: 1. Tokens: 1.0M.\n\n${FOOTER}\n`;

    expect(check(bare, "--branch", "chore/x").status).toBe(0);
    expect(check(bare, "--branch", "bug/7").lines).toEqual([
      expect.stringContaining("no `Assessment: complete` line"),
      "pr-body: no `### Status` section",
      expect.stringContaining("no `## Assumptions` section"),
    ]);
  });

  it("fails prose over 200 words, not counting code blocks, checklist lines or the Status, Assumptions and Review sections", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    const counted = valid.replace("Closes #12", `Closes #12\n\n${words(201)}`);
    expect(check(counted)).toEqual({
      status: 1,
      lines: [expect.stringContaining("203 words outside the checklist")],
    });
    expect(check(counted, "--draft-ok").status).toBe(0);

    const uncounted = valid
      .replace("Implement: done", `Implement: done ${words(300)}`)
      .replace("- [x] a Done when line", `- [x] ${words(300)}`)
      .replace("Closes #12", "Closes #12\n\n```\n" + words(300) + "\n```");
    expect(check(uncounted).status).toBe(0);
    expect(check(uncounted).lines).toEqual([]);
  });

  it("reads a PR's body and branch from the repo-scoped REST pulls endpoint, a null body as empty", () => {
    const bare = `## Review\n\n${COUNTS}\nRounds: 1. Tokens: 1.0M.\n\n${FOOTER}\n`;
    expect(fromGitHub({ body: bare, head: { ref: "chore/x" } })).toEqual({ status: 0, lines: [] });

    expect(
      fromGitHub({ body: bare, head: { ref: "bug/7" } }, { comments: [], routes: LONE_ISSUE })
        .lines,
    ).toEqual([
      expect.stringContaining("no `Assessment: complete` line"),
      "pr-body: no `### Status` section",
      expect.stringContaining("no `## Assumptions` section"),
      expect.stringContaining("no comment headed `## Review ledger`"),
    ]);
    expect(fromGitHub({ body: null, head: { ref: "chore/x" } }).lines).toEqual([
      expect.stringContaining('the last line is not "*Written by an agent.*"'),
      expect.stringContaining("no `## Review` section"),
    ]);
  });

  it("requires the Review ledger comment on a delivery branch whose reviews ran, and only there", () => {
    const body = valid;
    const ledger = `## Review ledger\n\nRound 1: ${"a".repeat(40)}\n\`\`\`json\n{"findings": []}\n\`\`\``;
    const task = (b: string, comments?: string[]) =>
      fromGitHub(
        { body: b, head: { ref: "task/7" } },
        { ...(comments !== undefined && { comments }), routes: LONE_ISSUE },
      );
    expect(task(body, ["hi", ledger])).toEqual({ status: 0, lines: [] });
    expect(task(body, ["hi"]).lines).toEqual([
      "pr-body: no comment headed `## Review ledger` (REVIEW.md, Measurement)",
    ]);
    const skipped = body.replace(
      COUNTS,
      "Spec review: skipped. Code review: skipped. Claims review: skipped.",
    );
    expect(task(skipped).lines).toEqual([expect.stringContaining("Spec review is skipped")]);
    expect(fromGitHub({ body, head: { ref: "chore/x" } }).status).toBe(0);
  });

  it("fails an open finding, a malformed or repeated round, a round off the head, and two notes comments", () => {
    const { dir, head, older } = scratchRepo();
    const ledger = (rounds: string, findings = "[]") =>
      `## Review ledger\n\n${rounds}\n\`\`\`json\n{"findings": ${findings}}\n\`\`\``;
    const task = (...comments: string[]) =>
      fromGitHub(
        { body: valid, head: { ref: "task/7", sha: older } },
        { comments, routes: LONE_ISSUE, cwd: dir },
      );

    expect(task(ledger(`Round 1: ${older}\nRound fix-check: ${older}`))).toEqual({
      status: 0,
      lines: [],
    });
    expect(task(ledger(`Round 1: ${older}`, '[{"id":"R2","outcome":"open"}]')).lines).toEqual([
      expect.stringContaining("finding R2 is open"),
    ]);
    expect(task(ledger("Round 1: abc")).lines).toEqual([
      expect.stringContaining('is not "Round <1|2|fix-check>: <full sha>"'),
    ]);
    expect(task(ledger(`Round 2: ${older}\nRound 1: ${older}`)).lines).toEqual([
      expect.stringContaining("first round is not round 1"),
    ]);
    expect(task(ledger(`Round 1: ${older}\nRound 1: ${older}`)).lines).toEqual([
      expect.stringContaining("more than one round 1 or round 2"),
    ]);
    expect(task(ledger(`Round 1: ${head}`)).lines).toEqual([
      expect.stringContaining("is not an ancestor of the head"),
    ]);
    expect(task(ledger(`Round 1: ${"b".repeat(40)}`)).lines).toEqual([
      expect.stringContaining("its ancestry is unchecked"),
    ]);
    const notes = "## Review notes\n\n- spec: x\n\n*Written by an agent.*";
    expect(task(ledger(`Round 1: ${older}`), notes, notes).lines).toEqual([
      expect.stringContaining("more than one comment is headed `## Review notes`"),
    ]);
  });

  it("fails an Assumptions line that is not none or one Assumption line", () => {
    const body = (line: string) => valid.replace("\nnone\n", `\n${line}\n`);

    expect(
      check(body("- Assumption: the wording — today's text, the smallest change.")).status,
    ).toBe(0);
    expect(check(body("- I picked the shorter message")).lines).toEqual([
      expect.stringContaining('an Assumptions line is not "none"'),
    ]);
    expect(check(body("- Assumption: a bound with no choice")).status).toBe(1);
  });

  it("walks the issue's Done when lines as checklist lines, ticked once the PR is ready, matching a reworded line by its words", () => {
    const issue = {
      "issues/7": {
        body: "## Done when\n\n- `pnpm test:changed` passes with the Tests lines above.\n- The website build passes.\n\n## Out of scope\n\nx\n",
      },
      "issues/7/parent": null,
    };
    const body = (list: string) => valid.replace("- [x] a Done when line", list);
    const ledger1 = `## Review ledger\n\nRound 1: ${"a".repeat(40)}\n\`\`\`json\n{"findings": []}\n\`\`\``;
    const task = (list: string) =>
      fromGitHub(
        { body: body(list), head: { ref: "task/7" } },
        { comments: [ledger1], routes: issue },
      );

    expect(
      task(
        "- [x] pnpm test:changed passes with the Tests lines above — 9/9 green\n- [x] The website build passes.",
      ),
    ).toEqual({ status: 0, lines: [] });
    expect(
      task(
        "- [x] `pnpm test:changed` passes with the Tests lines above.\n- [ ] The website build passes.",
      ).lines,
    ).toEqual([expect.stringContaining('"The website build passes." is not ticked')]);
    expect(task("- [x] The website build passes.").lines).toEqual([
      expect.stringContaining(
        '#7\'s Done when line "`pnpm test:changed` passes with the Tests lines ab" is not a checklist line',
      ),
    ]);
    expect(
      task(
        "- [x] Website builds and passes — ran it\n- [x] With the `Tests` line above `pnpmTest:changed` passing:\n  9/9 green",
      ),
    ).toEqual({ status: 0, lines: [] });
    expect(task("- [x] The website build passes.\n- [x] pnpm ran, 9/9 green").lines).toEqual([
      expect.stringContaining("is not a checklist line"),
    ]);
  });

  it("walks the parent's Completion conditions on the PR that closes its last open sub-issue, counting the stack below", () => {
    const ledger1 = `## Review ledger\n\nRound 1: ${"a".repeat(40)}\n\`\`\`json\n{"findings": []}\n\`\`\``;
    const parent = {
      number: 9,
      body: "## Completion conditions\n\n- One requester holds an iOS and an Android lease.\n",
    };
    const routes = (subIssues: object[], stack: object[] | null) => ({
      "issues/7": { body: "" },
      "issues/7/parent": parent,
      "issues/9/sub_issues -f per_page=100": subIssues,
      "stacks?pull_request=7": stack,
      "pulls/5": { body: "Closes #6" },
    });
    const task = (r: object) =>
      fromGitHub(
        { body: valid, head: { ref: "task/7" } },
        { comments: [ledger1], routes: r as Record<string, unknown> },
      );
    const missing = [expect.stringContaining("#9's Completion conditions line")];
    const open6 = [
      { number: 6, state: "open" },
      { number: 7, state: "open" },
    ];
    const stack = [{ open: true, pull_requests: [{ number: 5 }, { number: 7 }] }];

    expect(task(routes([{ number: 7, state: "open" }], null)).lines).toEqual(missing);
    expect(task(routes(open6, stack)).lines).toEqual(missing);
    expect(task(routes(open6, null))).toEqual({ status: 0, lines: [] });
    expect(
      task(routes(open6, [{ open: true, pull_requests: [{ number: 7 }, { number: 5 }] }])),
    ).toEqual({ status: 0, lines: [] });
  });

  it("fails a skipped lens the diff's kind needs, and warns on a claims lens for an ADR-only diff", () => {
    const counts = (spec: string, code: string, claims: string) =>
      valid.replace(
        COUNTS,
        `Spec review: ${spec}. Code review: ${code}. Claims review: ${claims}.`,
      );
    const ran = "0 blocking, 0 fixed, 0 notes";

    expect(check(counts(ran, "skipped", ran), "--kind", "docs-only").status).toBe(0);
    expect(
      check(counts("skipped", "skipped", "skipped"), "--branch", "chore/lints", "--kind", "full")
        .status,
    ).toBe(0);
    for (const kind of ["full", "large", "tests-only"]) {
      expect(
        check(counts(ran, "skipped", ran), "--branch", "task/12", "--kind", kind).lines,
      ).toEqual([expect.stringContaining(`Code review is skipped on a ${kind} diff`)]);
    }
    expect(
      check(counts("skipped", ran, ran), "--branch", "task/12", "--kind", "full").lines,
    ).toEqual([expect.stringContaining("Spec review is skipped")]);
    expect(check(counts(ran, "skipped", ran), "--kind", "adr-only")).toEqual({
      status: 0,
      lines: [expect.stringContaining("warning: a Claims review ran on an adr-only diff")],
    });
  });

  it("holds a routine's PR to its kind of change, reading the diff from git", () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-body-git-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, ".agents", "briefs"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, ".agents", "briefs", "calibration.md"), "x\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, ".agents", "briefs", "calibration.md"), "y\n");
    git("commit", "-qam", "change");
    const head = git("rev-parse", "HEAD");
    const routine = (branch: string) => {
      const file = join(repo, "body.md");
      writeFileSync(file, valid);
      try {
        execFileSync(
          process.execPath,
          [SCRIPT, "--body-file", file, "--branch", branch, "--base", base, "--head", head],
          {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, GITHUB_ACTIONS: "" },
          },
        );
        return [];
      } catch (error) {
        return (error as { stdout: string }).stdout.split("\n").filter((l) => l !== "");
      }
    };

    expect(routine("chore/garden-comments-2026-10-25")).toEqual([
      expect.stringContaining("this routine's PR must be comments-only, and its diff is full"),
      expect.stringContaining("Code review is skipped on a full diff"),
    ]);
    expect(routine("chore/audit-tests-2026-10-25")).toContainEqual(
      expect.stringContaining("must be tests-only"),
    );
    expect(routine("chore/calibrate-reviews-2026-10-25")).toContainEqual(
      expect.stringContaining("it also changes src/a.ts"),
    );
  });

  it("takes the repo from the origin remote when GH_REPO is unset", () => {
    const bare = `## Review\n\n${COUNTS}\nRounds: 1. Tokens: 1.0M.\n\n${FOOTER}\n`;
    const result = fromGitHub({ body: bare, head: { ref: "chore/x" } }, { origin: true });
    expect(result).toEqual({ status: 0, lines: [] });
  });

  it("with --draft-ok, reports every failure as a warning and exits 0", () => {
    const result = check(`## Review\n\nLooks good.\n`, "--draft-ok");

    expect(result.status).toBe(0);
    expect(result.lines).toHaveLength(3);
  });
});
