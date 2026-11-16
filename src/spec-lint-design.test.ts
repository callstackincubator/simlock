import { describe, expect, it } from "vitest";

import { FENCE, FOOTER, SHA, lintFeature, lintTask, swap } from "./test-spec-lint.js";

const DESIGN_TASK = `Part of #50.

## Scope

An operator's config file is read. Gone wrong: the daemon starts with defaults.

## Technical spec

Commit ${SHA.slice(0, 9)}.

### Rows

Behaviours: B1, B2. Stored state: S1. Existing code: X1.

### Facts

none

### Modules touched

Searches: \`loadConfig\` (2 hits).

- \`src/core/config.ts\`, from \`core/config.ts:1\`.

### Rules in play

- \`docs/internal/agent-rules/architecture.md\` rule 10: read once.

### Tests

Seam: \`loadConfig\`, modelled on \`src/diff-kind.test.ts\`.

- B1: an operator's config is read: a number or an object accepted, a bad value refused.
- B2: an operator sees the path of a config that does not parse.

## Done when

- \`pnpm test:changed\` passes.

## Out of scope

## Depends on

${FOOTER}
`;

const design = (tasks: [string, string]) => `Request: none

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

none

## Non-goals

## Completion conditions

- The worker keeps the profile.

## Open questions

## Decisions

- ADR 0001 — one: two.

## Behaviours

| Id | Behaviour (invoker, action, what it sees) | Seam | Cases | Task |
| -- | --- | --- | --- | --- |
| B1 | An operator's config is read | \`loadConfig\` | \`2\`; \`{}\`; \`0\` refused | ${tasks[0]} |
| B2 | An operator sees the path of a config that does not parse | \`loadConfig\` | bad JSON | ${tasks[0]} |
| B3 | A caller reads the profile over the socket | dispatcher | present; absent | ${tasks[1]} |

## Stored state

| Id | What and where | Created, changed, deleted by | Listed or swept by | A restart mid-step leaves | Schema step | Task | Used by |
| -- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Table \`profiles\`, read in \`src/core/config.ts:1\` | created at start | doctor | nothing | \`registry +1\` | ${tasks[0]} | ${tasks[1]} |

## Interfaces

| Id | What | Shape and bounds | Errors and limits | Where | Task | Used by |
| -- | --- | --- | --- | --- | --- | --- |
| I1 | \`profile.get\` | \`name\`: 1 to 64 characters; bumps the protocol by one | \`UNKNOWN_PROFILE\`: \`no profile named "<name>"\` | \`src/core/config.ts\` | ${tasks[1]} | — |

## Existing code

Commit ${SHA.slice(0, 9)}.

Searches: \`loadConfig\` (2 hits).

| Id | Code (path:line) | Today | With this feature | Handled by |
| -- | --- | --- | --- | --- |
| X1 | \`src/core/config.ts:1-2\` | reads the file | also reads profiles | S1 |

## Tasks

- ${tasks[0]} Keep the profile.
- ${tasks[1]} Read it over the socket.

${FOOTER}
`;

const DESIGN_FEATURE = design(["#100", "#102"]);

const SOCKET_TASK = `### Rows

Behaviours: B3. Interfaces: I1.

### Tests

Seam line.

- B3: a caller reads the profile over the socket: present, absent.

## Depends on

- #100
`;

const DESIGN_WORLD = {
  200: { labels: ["feature:planned"], subIssues: [100, 102] },
  100: { body: DESIGN_TASK, labels: ["task:ready"], parent: 50 },
  102: { body: SOCKET_TASK, labels: ["task:ready"] },
};

const fromRows = (body: string) => body.slice(body.indexOf("## Behaviours"));

describe("spec-lint.mjs on a task that names its parent's design rows", () => {
  it("passes when Rows holds every row the parent gives it and Tests has one line per Behaviours id", () => {
    expect(lintTask(DESIGN_TASK, DESIGN_FEATURE)).toEqual({
      status: 0,
      lines: ["spec-lint: 0 blocking, 0 notes"],
    });
  });

  it.each([
    [
      "a section of the old layout",
      swap("### Facts\n", "### Failure modes\n\nnone\n\n### Facts\n"),
      "N 100 Technical spec: `### Failure modes` is not a template section",
    ],
    [
      "no Rows section",
      swap("### Rows\n\nBehaviours: B1, B2. Stored state: S1. Existing code: X1.\n\n", ""),
      "B 100 Technical spec: `### Rows` is missing; add it",
    ],
    [
      "an id the parent does not have",
      swap("Existing code: X1.", "Existing code: X9."),
      "B 100 Rows: X9 is no row of the parent; fix the id",
    ],
    [
      "a row the parent gives it left out",
      swap("Stored state: S1. ", ""),
      "B 100 Rows: the parent gives S1 to this task; list it",
    ],
    [
      "a Tests line with no id",
      swap("- B2: an operator sees", "- An operator sees"),
      "B 100 Tests: line 2 does not start with its Behaviours id, as in `B3: ...`",
    ],
    [
      "a Tests line for another task's row",
      swap("- B2: an operator sees", "- B3: an operator sees"),
      "B 100 Tests: line 2 names B3, which the parent does not give to #100",
    ],
    [
      "two Tests lines for one row",
      swap("- B2: an operator sees", "- B1: an operator sees"),
      "B 100 Tests: two lines for B1; one line per row",
    ],
    [
      "a Behaviours row with no Tests line",
      swap("- B2: an operator sees the path of a config that does not parse.\n", ""),
      "B 100 Behaviours: #100 has no Tests line for B2; add it",
    ],
  ])("reports %s", (_name, change, line) => {
    expect(lintTask(change(DESIGN_TASK), DESIGN_FEATURE).lines).toContain(line);
  });
});

describe("spec-lint.mjs on a feature with design tables", () => {
  it("takes `none` under Existing code's Commit and Searches lines, and `none` or a dash in backticks in a cell", () => {
    const sentinels = [
      swap(
        "| Id | Code (path:line) | Today | With this feature | Handled by |\n| -- | --- | --- | --- | --- |\n| X1 | `src/core/config.ts:1-2` | reads the file | also reads profiles | S1 |",
        "none",
      ),
      swap("| `registry +1` | #100 | #102 |", "| `none` | `#100` | #102 |"),
      swap("| #102 | — |", "| #102 | `—` |"),
    ].reduce((body, change) => change(body), DESIGN_FEATURE);

    expect(lintFeature(sentinels, DESIGN_WORLD)).toEqual({
      status: 0,
      lines: ["N 200 Depends on: chain 2 of 2 tasks", "spec-lint: 0 blocking, 1 notes"],
    });
  });

  it("passes when ids, steps and hand-offs agree with its tasks, and before any task is posted", () => {
    expect(lintFeature(DESIGN_FEATURE, DESIGN_WORLD)).toEqual({
      status: 0,
      lines: ["N 200 Depends on: chain 2 of 2 tasks", "spec-lint: 0 blocking, 1 notes"],
    });
    expect(lintFeature(design(["T1", "T2"]), { 200: { labels: ["feature:spec"] } })).toEqual({
      status: 0,
      lines: ["spec-lint: 0 blocking, 0 notes"],
    });
  });

  it.each([
    [
      "a design section left out",
      swap("## Interfaces\n", "## Ports\n"),
      DESIGN_WORLD,
      "B 200 body: `## Interfaces` is missing; add it",
    ],
    [
      "a design table with no Id column",
      (body: string) =>
        body.replace(fromRows(body), fromRows(body).replace("| Id | What |", "| What |")),
      DESIGN_WORLD,
      "B 200 Interfaces: no table with an `Id` column; add the rows, or write `none`",
    ],
    [
      "a design section with no table whose prose only starts a line with none",
      (body: string) =>
        body.replace(
          /## Interfaces\n[\s\S]*?\n## Existing code/,
          "## Interfaces\n\nThe socket adds `profile.get` for callers, and\nnone of the old calls change.\n\n## Existing code",
        ),
      DESIGN_WORLD,
      "B 200 Interfaces: no table with an `Id` column; add the rows, or write `none`",
    ],
    [
      "Existing code that says none without its searches",
      (body: string) =>
        body.replace(
          /Searches: `loadConfig` \(2 hits\)\.\n\n\| Id \| Code[\s\S]*?\| S1 \|\n/,
          "none\n",
        ),
      DESIGN_WORLD,
      "B 200 Existing code: no `Searches:` line; name the searches that found the list",
    ],
    [
      "an id of another table's letter",
      swap("| S1 | Table", "| B4 | Table"),
      DESIGN_WORLD,
      'B 200 Stored state: "B4" is no id; number the rows S1, S2',
    ],
    [
      "an id used twice",
      swap("| B2 | An operator sees", "| B1 | An operator sees"),
      DESIGN_WORLD,
      "B 200 Behaviours: B1 is used twice; renumber one",
    ],
    [
      "no Commit line under Existing code",
      swap(`Commit ${SHA.slice(0, 9)}.\n\nSearches`, "Searches"),
      DESIGN_WORLD,
      "B 200 Existing code: no `Commit <sha>.` line, so no path:line can be checked; add the commit read",
    ],
    [
      "a path:line past the end of its file",
      swap("read in `src/core/config.ts:1`", "read in `src/core/config.ts:99999`"),
      DESIGN_WORLD,
      expect.stringMatching(/^B 200 Stored state: `src\/core\/config\.ts:99999` is past the end/),
    ],
    [
      "Existing code with no searches",
      swap("Searches: `loadConfig` (2 hits).\n\n| Id | Code", "| Id | Code"),
      DESIGN_WORLD,
      "B 200 Existing code: no `Searches:` line; name the searches that found the list",
    ],
    [
      "a protocol version under Interfaces",
      swap("bumps the protocol by one", "protocol 78"),
      DESIGN_WORLD,
      "B 200 Interfaces: names a protocol version; say `bumps the protocol by one`",
    ],
    [
      "a Schema step that is a version",
      swap("`registry +1`", "V2"),
      DESIGN_WORLD,
      'B 200 Stored state: S1\'s Schema step "V2" is not `<owner> +<n>` or `none`',
    ],
    [
      "one schema step taken by two tasks",
      swap(
        "| `registry +1` | #100 | #102 |\n",
        "| `registry +1` | #100 | #102 |\n| S2 | Column `devices.profile` | at provision | list | nothing | `registry +1` | #102 | — |\n",
      ),
      DESIGN_WORLD,
      "B 200 Stored state: S1 and S2 both take `registry +1` in different tasks; give the later task the next step",
    ],
    [
      "a Stored state row of two tasks",
      swap("| `registry +1` | #100 | #102 |", "| `registry +1` | #100, #102 | — |"),
      DESIGN_WORLD,
      'B 200 Stored state: S1\'s Task cell "#100, #102" is not one task; name the task that adds it',
    ],
    [
      "a Task cell still `T1` once the tasks are posted",
      (body: string) => body.replace(fromRows(body), fromRows(body).replaceAll("#102", "T2")),
      DESIGN_WORLD,
      'B 200 Interfaces: I1\'s Task cell "T2" names no sub-issue; name the task',
    ],
    [
      "a Used by cell that names a module, not a task",
      swap("| `registry +1` | #100 | #102 |", "| `registry +1` | #100 | the CLI |"),
      DESIGN_WORLD,
      'B 200 Stored state: S1\'s Used by "the CLI" names no task; name the tasks, or write `—`',
    ],
    [
      "a task that uses a row without depending on the task that provides it",
      (body: string) => body,
      { ...DESIGN_WORLD, 102: { body: SOCKET_TASK.replace("- #100\n", "") } },
      "B 102 Depends on: #102 uses S1, which #100 provides, but does not depend on it; add #100",
    ],
  ])("reports %s", (_name, change, world, line) => {
    expect(lintFeature(change(DESIGN_FEATURE), world).lines).toContainEqual(line);
  });
});
