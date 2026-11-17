import { describe, expect, it } from "vitest";

import { FENCE, FOOTER, WORLD, lintFeature, task } from "./test-spec-lint.js";

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
