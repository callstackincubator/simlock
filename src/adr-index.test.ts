import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "internal", "adr");

function statusOf(text: string): string | undefined {
  return /^(?:Proposed|Accepted(?: — (?:not yet|partly) implemented)?|Superseded by \d{4}|Rejected)/.exec(
    text,
  )?.[0];
}

// why: docs/internal/adr/README.md merges by union (.gitattributes), so two features' rows can
// land in any order and a row can go missing only when nobody wrote it; this proves the table.
describe("the ADR index", () => {
  const files = readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
  const rows = readFileSync(join(ADR_DIR, "README.md"), "utf8")
    .split("\n")
    .map((line) => /^\| \[(\d{4})\]\(([^)]+)\) \|[^|]*\|([^|]*)\|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ number: match[1], file: match[2], status: match[3]!.trim() }));

  it("has one row per ADR file, naming that file", () => {
    expect(rows.map((row) => row.file).sort()).toEqual(files);
  });

  it("gives each ADR the status its own Status line gives", () => {
    const fileStatus = (file: string) =>
      /^- \*\*Status:\*\* (.*)$/m.exec(readFileSync(join(ADR_DIR, file), "utf8"))?.[1] ?? "";
    const differ = rows
      .map((row) => ({
        row: statusOf(row.status),
        file: statusOf(fileStatus(row.file ?? "")),
        number: row.number,
      }))
      .filter(({ row, file }) => row === undefined || row !== file)
      .map(({ number, row, file }) => `${number}: index ${row}, file ${file}`);

    expect(statusOf("Accepted — not yet implemented; §2 narrowed by 0046")).toBe(
      "Accepted — not yet implemented",
    );
    expect(statusOf("Superseded by 0034 (per-home isolation)")).toBe("Superseded by 0034");
    expect(differ).toEqual([]);
  });

  it("lists the rows in ascending order with no number twice", () => {
    const numbers = rows.map((row) => row.number);
    expect(numbers).toEqual([...new Set(numbers)].sort());
  });
});
