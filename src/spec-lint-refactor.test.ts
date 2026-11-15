import { describe, expect, it } from "vitest";

import { FOOTER, lint, swap, write } from "./test-spec-lint.js";

const REFACTOR = `## Why

\`src/daemon/main.ts\` has 1,908 lines, over ADR 0063's cut-off of 1,400.

## Target shape

- \`composeWorker\` moves to \`src/daemon/worker-composition.ts\`.

## Out of bounds

- \`src/daemon/server.ts\`.

## Done when

- No file in \`src/daemon/\` has more than 1,400 lines.

${FOOTER}
`;

describe("spec-lint.mjs on a refactor", () => {
  const lintRefactor = (body: string, labels = ["refactor:ready"]) =>
    lint([
      "100",
      "--body-file",
      write("refactor.md", body),
      "--world",
      write("world.json", JSON.stringify({ 100: { labels } })),
    ]);

  it("passes Why, Target shape, Out of bounds and Done when with text, and asks for nothing a task has", () => {
    expect(lintRefactor(REFACTOR)).toEqual({
      status: 0,
      lines: ["spec-lint: 0 blocking, 0 notes"],
    });
  });

  it.each([
    [
      "a missing section",
      swap("## Out of bounds\n\n- `src/daemon/server.ts`.\n\n", ""),
      "B 100 body: `## Out of bounds` is missing; add it",
    ],
    [
      "an empty section",
      swap("- `composeWorker` moves to `src/daemon/worker-composition.ts`.", ""),
      "B 100 Target shape: empty; fill it in",
    ],
    [
      "sections out of order",
      (body: string) =>
        body
          .replace("## Why", "## Swap")
          .replace("## Target shape", "## Why")
          .replace("## Swap", "## Target shape"),
      "B 100 body: `## Target shape` is out of template order; move it",
    ],
  ])("blocks %s", (_, change, expected) => {
    const result = lintRefactor(change(REFACTOR));

    expect(result.lines).toContain(expected);
    expect(result.status).toBe(1);
  });

  it("reads a body with no refactor label as a refactor under --refactor", () => {
    const result = lint(["--refactor", "--body-file", write("refactor.md", REFACTOR)]);

    expect(result).toEqual({ status: 0, lines: ["spec-lint: 0 blocking, 0 notes"] });
  });
});
