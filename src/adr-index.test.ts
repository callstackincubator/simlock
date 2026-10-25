import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "internal", "adr");

// why: docs/internal/adr/README.md merges by union (.gitattributes), so two features' rows can
// land in any order and a row can go missing only when nobody wrote it; this proves the table.
describe("the ADR index", () => {
  const files = readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
  const rows = readFileSync(join(ADR_DIR, "README.md"), "utf8")
    .split("\n")
    .map((line) => /^\| \[(\d{4})\]\(([^)]+)\) \|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ number: match[1], file: match[2] }));

  it("has one row per ADR file, naming that file", () => {
    expect(rows.map((row) => row.file).sort()).toEqual(files);
  });

  it("lists the rows in ascending order with no number twice", () => {
    const numbers = rows.map((row) => row.number);
    expect(numbers).toEqual([...new Set(numbers)].sort());
  });
});
