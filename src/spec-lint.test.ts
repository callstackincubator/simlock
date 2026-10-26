import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, ".agents", "scripts", "spec-lint.mjs");
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const FOOTER = "*Written by an agent.*";
const FENCE = "```";

const TASK = `Part of #50.

## Scope

An operator's config file is read.

## In short

The daemon reads the file.

${FENCE}mermaid
flowchart LR
  A[config.json] --> B[loadConfig]
${FENCE}

## Technical spec

Commit ${SHA.slice(0, 9)}.

### Facts

| #  | Fact | Source |
| -- | ---- | ------ |
| F1 | \`loadConfig\` reads the file. | \`src/core/config.ts:1-2\`, \`:3\` |
| F2 | The package has a name. | \`package.json:2\`; \`node_modules/zod/package.json:9999\` |

### Modules touched

Searches: \`loadConfig\` (2 hits).

- \`src/core/config.ts\`, from \`core/config.ts:1\`.

### Contract and event changes

None.

### Other code on the same state

Searches: \`loadConfig\` (2 hits). None.

### Failure modes

| Call | Outcome | What happens | Limit, counted from |
| ---- | ------- | ------------ | ------------------- |
| file read | ok | the config is returned | at start |

### Rules in play

- Architecture rule 10, "one decision in one place": \`v1.2.3:src/far.ts:7\` is read once.

### Tests

Seam: \`loadConfig\`, modelled on \`src/diff-kind.test.ts\`.

- An operator's config is read: a number or an object accepted, a bad value refused.

## Done when

- \`pnpm test:changed\` passes.

## Out of scope

## Depends on

${FOOTER}
`;

const PARENT = `Request: none

## Behaviours

| Behaviour (invoker, action, what it sees) | Seam | Cases | Task |
| --- | --- | --- | --- |
| An operator's config is read: number or object accepted, bad value refused | \`loadConfig\` | \`2\`; \`{}\`; \`0\` refused | #100 |

${FOOTER}
`;

function write(name: string, text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "spec-lint-")), name);
  writeFileSync(file, text);
  return file;
}

function lint(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return { status: 0, lines: stdout.split("\n").filter((l) => l !== "") };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, lines: failed.stdout.split("\n").filter((l) => l !== "") };
  }
}

function lintTask(body: string, parent: string | null = PARENT) {
  return lint([
    "100",
    "--body-file",
    write("task.md", body),
    ...(parent === null ? [] : ["--parent-file", write("parent.md", parent)]),
    "--world",
    write("world.json", JSON.stringify({ 100: { parent: 50 } })),
  ]);
}

const swap = (from: string, to: string) => (body: string) => {
  expect(body).toContain(from);
  return body.replace(from, to);
};
const LINE = "- An operator's config is read: a number or an object accepted, a bad value refused.";
const tests = (n: number) =>
  Array.from({ length: n }, (_, i) => `- An operator's config is read, case ${i}.`).join("\n");

describe("spec-lint.mjs on a task", () => {
  it("passes a body that meets every structural rule, with no line printed but the count", () => {
    expect(lintTask(TASK)).toEqual({ status: 0, lines: ["spec-lint: 0 blocking, 0 notes"] });
  });

  it.each([
    [
      "a missing section",
      swap("## Out of scope\n\n", ""),
      "B 100 body: `## Out of scope` is missing; add it",
    ],
    [
      "sections out of order",
      (body: string) =>
        body
          .replace("### Contract and event changes", "### Swap")
          .replace("### Other code on the same state", "### Contract and event changes")
          .replace("### Swap", "### Other code on the same state"),
      "B 100 Technical spec: `### Other code on the same state` is out of template order; move it",
    ],
    [
      "a `#NNN` placeholder",
      swap("## Depends on\n", "## Depends on\n\n- #NNN\n"),
      "B 100 body: `#NNN` placeholder; name the issue",
    ],
    [
      "a `- ...` bullet",
      swap("## Out of scope\n", "## Out of scope\n\n- ...\n"),
      "B 100 body: a `- ...` placeholder bullet; fill it in or delete it",
    ],
    [
      "a row of `...` cells",
      swap("| file read | ok |", "| ... | ... | ... | ... |\n| file read | ok |"),
      "B 100 body: a table row of `...` cells; fill it in or delete it",
    ],
    [
      "a template comment",
      swap(
        "## Out of scope\n",
        "## Out of scope\n\n<!-- One issue per line. Leave empty if none. -->\n",
      ),
      'B 100 body: template comment "One issue per line. Leave empty if none.…" is still there; delete it',
    ],
    [
      "no footer",
      swap(FOOTER, "Thanks."),
      "B 100 body: the last line is not `*Written by an agent.*`",
    ],
    [
      "no Part of line",
      swap("Part of #50.", "Belongs to #50."),
      "B 100 body: the first line is not `Part of #<feature>.`",
    ],
    [
      "a Part of that is not the GitHub parent",
      swap("Part of #50.", "Part of #51."),
      "B 100 body: `Part of #51` but GitHub's parent is #50; make them agree",
    ],
    [
      "no mermaid in In short",
      swap(`${FENCE}mermaid`, `${FENCE}text`),
      "B 100 In short: no ```mermaid block; add the small diagram the template asks for",
    ],
    [
      "no commit line",
      swap(`Commit ${SHA.slice(0, 9)}.`, ""),
      "B 100 Facts: no `Commit <sha>.` line, so no path:line can be checked; add the commit read",
    ],
    [
      "a commit this clone lacks",
      swap(`Commit ${SHA.slice(0, 9)}.`, "Commit 0000000000."),
      "B 100 Facts: commit 0000000000 is not in this clone; fetch it, or cite one that is",
    ],
    [
      "an empty Source",
      swap("| `package.json:2`; `node_modules/zod/package.json:9999` |", "|  |"),
      "B 100 Facts: F2 has no Source; cite the line or command it was read from",
    ],
    [
      "a Source that is memory",
      swap("| `package.json:2`; `node_modules/zod/package.json:9999` |", "| memory |"),
      'B 100 Facts: F2\'s Source is "memory", which is no source; cite the line read',
    ],
    [
      "a fact about code read from docs only",
      swap("`src/core/config.ts:1-2`, `:3` |", "`docs/internal/ARCHITECTURE.md:1` |"),
      "N 100 Facts: F1 names code but cites only docs; cite the code line",
    ],
    [
      "a repeated F number",
      swap("| F2 |", "| F1 |"),
      "B 100 Facts: F1 is used twice; renumber one",
    ],
    [
      "a line past the end of its file",
      swap("`package.json:2`", "`package.json:99999`"),
      `B 100 Facts: \`package.json:99999\` is past the end of package.json (`,
    ],
    [
      "a continuation past the end",
      swap("`:3`", "`:99999`"),
      "B 100 Facts: `src/core/config.ts:99999` is past the end of src/core/config.ts (",
    ],
    [
      "a path this repo lacks, in Modules touched",
      swap("from `core/config.ts:1`", "from `dist/src/cli.js:12`"),
      `B 100 Modules touched: \`dist/src/cli.js:12\` is no file at ${SHA.slice(0, 9)}; fix the path, or cite another tool as \`node_modules/<pkg>/...\` or \`v<version>:<path>\``,
    ],
    [
      "an ambiguous file name, in Rules in play",
      swap("is read once.", "is read once (`index.ts:1`)."),
      "N 100 Rules in play: `index.ts:1` matches ",
    ],
    [
      "Modules touched with no searches",
      swap("Searches: `loadConfig` (2 hits).\n\n- `src/core", "- `src/core"),
      "B 100 Modules touched: no `Searches:` line; name the searches that found the list",
    ],
    [
      "Other code with no searches",
      swap("Searches: `loadConfig` (2 hits). None.", "None."),
      "B 100 Other code on the same state: no `Searches:` line; name the searches that found the list",
    ],
    [
      "more than 20 modules",
      swap(
        "- `src/core/config.ts`, from",
        `${Array.from({ length: 21 }, (_, i) => `- \`src/m${i}/x.ts\``).join("\n")}\n- \`src/core/config.ts\`, from`,
      ),
      "B 100 Modules touched: 22 modules; split the task, or say under Scope why it cannot split",
    ],
    [
      "a shape change without the bump wording",
      swap(
        "### Contract and event changes\n\nNone.",
        "### Contract and event changes\n\n- `lease.cancel` gains `platform`.",
      ),
      "B 100 Contract and event changes: a shape change without `this PR bumps the protocol by one`; add it, or start with `None`",
    ],
    [
      "a protocol version number",
      swap(
        "### Contract and event changes\n\nNone.",
        "### Contract and event changes\n\nThis PR bumps the protocol by one, to protocol 36.",
      ),
      "B 100 Contract and event changes: names a protocol version; say `this PR bumps the protocol by one`",
    ],
    [
      "an event without its EVENTS.md entry",
      swap(
        "### Contract and event changes\n\nNone.",
        "### Contract and event changes\n\nThis PR bumps the protocol by one. `lease.rejected` gains a reason.",
      ),
      "B 100 Contract and event changes: names an event but not its `EVENTS.md` entry; add it",
    ],
    [
      "Failure modes with no table",
      swap(
        "| Call | Outcome | What happens | Limit, counted from |",
        "| Call | Result | What happens | Limit |",
      ),
      "B 100 Failure modes: no `Call | Outcome | What happens | Limit, counted from` table and not `none`; add the table",
    ],
    [
      "Tests with no seam line",
      swap("Seam: `loadConfig`, modelled on `src/diff-kind.test.ts`.\n\n", ""),
      "B 100 Tests: no seam line before the bullets; name the seam and a test file to model on",
    ],
    [
      "a seam line naming a test file that does not exist",
      swap("`src/diff-kind.test.ts`", "`src/no-such.test.ts`"),
      "B 100 Tests: the seam line names no test file that exists; name one to model the tests on",
    ],
    [
      "a hardware line with no slow-lane test",
      swap("- `pnpm test:changed` passes.", "- On a Mac with an iOS runtime: the simulator boots."),
      'B 100 Done when: "On a Mac with an iOS runtime: the simulator boots." needs the slow lane but names no `e2e/slow-*.test.ts`; name it',
    ],
    [
      "a hardware line naming a test that does not exist",
      swap(
        "- `pnpm test:changed` passes.",
        "- In the slow lane, `e2e/slow-nothing.test.ts` passes.",
      ),
      'B 100 Done when: "In the slow lane, `e2e/slow-nothing.test.ts` passes." names a slow-lane test that does not exist and Modules touched does not add; fix the name',
    ],
    [
      "a Tests count that differs from the parent's Behaviours rows",
      swap("a bad value refused.", "a bad value refused.\n- A second line nothing backs."),
      "B 100 Behaviours: #100 has 2 Tests lines and 1 Behaviours rows; one line per row",
    ],
    [
      "a Tests line in other words than its row",
      swap(
        "An operator's config is read: a number or an object accepted, a bad value refused.",
        "Startup succeeds.",
      ),
      "N 100 Tests: line 1 shares 0% of its words with its best Behaviours row; copy the row's words",
    ],
  ])("reports %s", (_name, mutate, expected) => {
    const result = lintTask(mutate(TASK));

    expect(result.lines.some((line) => line.startsWith(expected))).toBe(true);
    expect(result.status).toBe(expected.startsWith("B") ? 1 : 0);
  });

  it("notes an F number that comes after a higher one", () => {
    const body = TASK.replace("| F1 |", "| F3 |");

    expect(lintTask(body).lines).toContain("N 100 Facts: F2 comes after F3");
  });

  it("passes Failure modes written as none", () => {
    const body = TASK.replace(
      /\| Call \| Outcome[\s\S]*?\| at start \|/,
      "none: the task crosses no boundary.",
    );

    expect(lintTask(body).status).toBe(0);
  });

  it("notes more than 10 Tests lines and blocks more than 30", () => {
    expect(lintTask(TASK.replace(LINE, tests(11)), null)).toEqual({
      status: 0,
      lines: ["N 100 Tests: 11 lines, over about 10", "spec-lint: 0 blocking, 1 notes"],
    });
    expect(lintTask(TASK.replace(LINE, tests(31)), null)).toEqual({
      status: 1,
      lines: [
        "B 100 Tests: 31 lines; split the task, or say under Scope why it cannot split",
        "spec-lint: 1 blocking, 0 notes",
      ],
    });
  });

  it("passes the size rules when Scope says why the task cannot split, and an existing slow-lane test or one Modules touched adds", () => {
    const body = TASK.replace(
      "An operator's config file is read.",
      "An operator's config file is read. One task, not two: the halves share one decision.",
    )
      .replace(LINE, tests(31))
      .replace(
        "- `pnpm test:changed` passes.",
        "- On a Mac with an iOS runtime: `e2e/slow-agent-device.test.ts` passes.\n- In the slow lane, `e2e/slow-new.test.ts` passes.",
      )
      .replace(
        "- `src/core/config.ts`, from",
        "- `e2e/slow-new.test.ts` (new).\n- `src/core/config.ts`, from",
      );

    expect(lintTask(body, null)).toEqual({ status: 0, lines: ["spec-lint: 0 blocking, 0 notes"] });
  });

  it("checks a draft with no number yet, without a parent to compare", () => {
    const result = lint(["--body-file", write("draft.md", TASK)]);

    expect(result).toEqual({ status: 0, lines: ["spec-lint: 0 blocking, 0 notes"] });
  });
});

const FEATURE = `Request: none

## Problem

Agents wait.

## Who it is for

An operator.

## Outcome

They do not wait.

## How it works for the user

${FENCE}mermaid
flowchart LR
  A --> B
${FENCE}

## Examples

## What could go wrong

## Words used

- profile: a file, e.g. \`p.json\`.

## Non-goals

## Completion conditions

- The worker keeps the profile.

## Open questions

## Decisions

- ADR 0001 — one: two.

## Shared values

none

## Behaviours

| Behaviour (invoker, action, what it sees) | Seam | Cases | Task |
| --- | --- | --- | --- |
| A worker restarts and keeps the profile | \`startDaemon\` | same bytes; new port | #101 |
| A caller cancels a waiting request by platform | dispatcher | given; absent | #102 |

## Tasks

- #101 Keep the profile.
- #102 Cancel by platform.

${FOOTER}
`;

const task = (line: string, depends: string[] = []) => `### Tests

Seam line.

- ${line}

## Depends on

${depends.map((d) => `- ${d}`).join("\n")}
`;

const WORLD = {
  200: { labels: ["feature:planned"], subIssues: [101, 102] },
  101: {
    body: task("A worker restarts and keeps the profile: same bytes, new port."),
    labels: ["task:ready"],
  },
  102: {
    body: task("A caller cancels a waiting request by platform: given, absent.", ["#101"]),
    labels: ["task:ready"],
  },
};

function lintFeature(body: string, world: Record<string, unknown> = WORLD) {
  return lint([
    "200",
    "--feature",
    "--body-file",
    write("feature.md", body),
    "--world",
    write("world.json", JSON.stringify(world)),
  ]);
}

describe("spec-lint.mjs on a feature", () => {
  it("passes a feature whose rows match its tasks, and prints the Depends on chain", () => {
    expect(lintFeature(FEATURE)).toEqual({
      status: 0,
      lines: ["N 200 Depends on: chain 2 of 2 tasks", "spec-lint: 0 blocking, 1 notes"],
    });
  });

  it.each([
    [
      "no Request line",
      FEATURE.replace("Request: none", "From the inbox."),
      WORLD,
      "B 200 body: the first line is not `Request: #<n>` or `Request: none`",
    ],
    [
      "open questions on a planned feature",
      FEATURE.replace("## Open questions\n", "## Open questions\n\n- Which port?\n"),
      WORLD,
      "B 200 Open questions: not empty on a planned feature; settle them, or move the feature back to feature:spec",
    ],
    [
      "empty Words used",
      FEATURE.replace("- profile: a file, e.g. `p.json`.", ""),
      WORLD,
      "B 200 Words used: empty; list the terms, or write `none`",
    ],
    [
      "no mermaid in How it works",
      FEATURE.replace(`${FENCE}mermaid`, FENCE),
      WORLD,
      "B 200 How it works for the user: no ```mermaid block; add the user's flow",
    ],
    [
      "a task with more Tests lines than rows",
      FEATURE,
      {
        ...WORLD,
        101: {
          body: task("A worker restarts and keeps the profile: same bytes.\n- A second line."),
        },
      },
      "B 101 Behaviours: #101 has 2 Tests lines and 1 Behaviours rows; one line per row",
    ],
    [
      "a row naming no sub-issue",
      FEATURE.replace("| given; absent | #102 |", "| given; absent | #103 |"),
      WORLD,
      'B 200 Behaviours: a row\'s Task cell "#103" names no sub-issue; name one',
    ],
    [
      "a sub-issue with no row",
      FEATURE.replace("| given; absent | #102 |", "| given; absent | #101 |"),
      WORLD,
      "B 200 Behaviours: #102 has no row; add its behaviours",
    ],
    [
      "a Depends on number that does not exist",
      FEATURE,
      {
        ...WORLD,
        102: { body: task("A caller cancels a waiting request by platform.", ["#999"]) },
      },
      "B 102 Depends on: #999 does not exist; fix the line",
    ],
    [
      "a cycle",
      FEATURE,
      { ...WORLD, 101: { body: task("A worker restarts and keeps the profile.", ["#102"]) } },
      "B 101 Depends on: a cycle: #101 → #102 → #101; drop one of its lines",
    ],
    [
      "a closed dependency",
      FEATURE,
      {
        ...WORLD,
        102: { body: task("A caller cancels a waiting request by platform.", ["#300"]) },
        300: { state: "closed" },
      },
      "N 102 Depends on: #300 is closed, so the line orders nothing; drop it",
    ],
    [
      "an open dependency of another feature",
      FEATURE,
      {
        ...WORLD,
        102: { body: task("A caller cancels a waiting request by platform.", ["#301"]) },
        301: { parent: 400 },
      },
      "N 102 Depends on: depends-outside #301 (open, feature #400)",
    ],
  ])("reports %s", (_name, body, world, expected) => {
    const result = lintFeature(body, world);

    expect(result.lines).toContain(expected);
    expect(result.status).toBe(expected.startsWith("B") ? 1 : 0);
  });
});
