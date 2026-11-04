import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function testsAgentsRun(file: string): string {
  const text = readFileSync(join(ROOT, file), "utf8");
  const section = /^## Tests agents run\n([\s\S]*?)(?=^## )/m.exec(text)?.[1] ?? "";
  return section
    .split("\n")
    .map((line) =>
      line.startsWith("|") ? line.replace(/ {2,}/g, " ").replace(/-{3,}/g, "-") : line,
    )
    .join("\n")
    .trim();
}

describe("the implementer's copy of the tests agents run", () => {
  it("says what toolchain.md says, table padding aside", () => {
    const rules = testsAgentsRun("docs/internal/agent-rules/toolchain.md");

    expect(rules).toContain("`pnpm test:changed`");
    expect(testsAgentsRun(".claude/agents/implementer.md")).toBe(rules);
  });
});
