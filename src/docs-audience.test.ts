import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every tracked path, from the git index, so no doc escapes by sitting in a directory the test did not name. */
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\0")
  .filter((name) => name.length > 0)
  // A path deleted from the working tree is still listed by `git ls-files`; only regular files
  // can be read.
  .filter((name) => {
    try {
      return statSync(join(REPO_ROOT, name)).isFile();
    } catch {
      return false;
    }
  });

/** `README.md` and every markdown file under `docs/` that is not under `docs/internal/`. */
const endUserDocs = trackedFiles.filter(
  (name) =>
    name === "README.md" ||
    (name.startsWith("docs/") && !name.startsWith("docs/internal/") && name.endsWith(".md")),
);

/**
 * File names that exist only under `docs/internal/`, compared ignoring case. `EVENTS.md`,
 * `events.md` and `README.md` are left out: an end-user doc of the same name exists, so the
 * bare name says nothing about the audience.
 */
const internalOnlyNames = [
  ...new Set(
    trackedFiles
      .filter((name) => name.startsWith("docs/internal/") && name.endsWith(".md"))
      .map((name) => basename(name)),
  ),
].filter((name) => !endUserDocs.some((doc) => basename(doc).toLowerCase() === name.toLowerCase()));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What documentation rule 2 forbids an end-user doc from naming. */
const FORBIDDEN: RegExp[] = [
  /docs\/internal\b/,
  // `internal/` starting a path: an inline, angle-bracket, reference-style or HTML link from
  // `docs/`, or the same path in backticks or prose.
  /(?<![\w./-])(?:\.\/)?internal\//,
  /\bADRs?\b/i,
  /\bdecision records?\b/i,
  ...internalOnlyNames.map((name) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "i")),
];

/**
 * Documentation rule 2 (`docs/internal/agent-rules/documentation.md`): an end-user doc never
 * cites an ADR and never points into `docs/internal/` -- by link, by path, or by an internal
 * doc's bare file name, in any case ("see ARCHITECTURE.md").
 */
describe("end-user docs", () => {
  it("include the known end-user docs, beside a list of internal-only names", () => {
    // Without this, an empty enumeration would leave the scan below with nothing to read and
    // the suite would pass while checking no doc at all.
    expect(endUserDocs).toEqual(
      expect.arrayContaining([
        "README.md",
        "docs/ABOUT.md",
        "docs/CLI.md",
        "docs/CLIENT.md",
        "docs/CONFIGURATION.md",
        "docs/EVENTS.md",
        "docs/HTTP-API.md",
      ]),
    );
    expect(internalOnlyNames).toEqual(
      expect.arrayContaining(["ARCHITECTURE.md", "KNOWN-PITFALLS.md", "testing.md"]),
    );
  });

  it("name no path under docs/internal/, no internal-only doc by file name, and no ADR", () => {
    const offenders = endUserDocs.flatMap((doc) =>
      readFileSync(join(REPO_ROOT, doc), "utf8")
        .split("\n")
        .flatMap((text, index) =>
          FORBIDDEN.flatMap((pattern) => {
            const match = pattern.exec(text);
            return match === null ? [] : [`${doc}:${index + 1}: ${match[0]}`];
          }),
        ),
    );

    expect(offenders).toEqual([]);
  });
});

/** The text of `markdown` from the first line starting with `from` up to the next starting with `to`. */
function section(markdown: string, from: string, to: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(from));
  const end = lines.findIndex((line, index) => index > start && line.startsWith(to));
  return start === -1 || end === -1 ? "" : lines.slice(start, end).join("\n");
}

/**
 * Documentation rule 1: `docs/` is the end-user directory, and a doc for maintainers or agents
 * goes under `docs/internal/`. The two places that name the end-user docs -- AGENTS.md's list
 * and rule 2's list -- are what a markdown file under `docs/` and outside `docs/internal/` has
 * to be one of. Both lists name files directly in `docs/`, so a doc in any other subdirectory
 * of `docs/` fails.
 */
describe("the markdown files under docs/ outside docs/internal/", () => {
  const inDocsDir = endUserDocs
    .filter((name) => name !== "README.md")
    .toSorted((a, b) => a.localeCompare(b));

  const listedInAgents = [
    ...section(
      readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8"),
      "End-user docs live directly under",
      "Maintainer/agent docs live under",
    ).matchAll(/\]\((docs\/[^/)]+\.md)\)/g),
  ]
    .map((match) => match[1] ?? "")
    .toSorted((a, b) => a.localeCompare(b));

  const listedInRule2 = [
    ...section(
      readFileSync(join(REPO_ROOT, "docs/internal/agent-rules/documentation.md"), "utf8"),
      "2. **",
      "3. **",
    ).matchAll(/`(docs\/[^/`]+\.md)`/g),
  ]
    .map((match) => match[1] ?? "")
    .toSorted((a, b) => a.localeCompare(b));

  it("were read, along with both lists of end-user docs", () => {
    // Without this, a heading reworded in AGENTS.md or documentation.md would empty a list
    // and the comparison below would fail for the wrong reason -- or, with docs/ also
    // empty, pass while checking nothing.
    for (const list of [inDocsDir, listedInAgents, listedInRule2]) {
      expect(list).toEqual(expect.arrayContaining(["docs/CLI.md", "docs/HTTP-API.md"]));
    }
  });

  it("are exactly the end-user docs AGENTS.md and documentation rule 2 list", () => {
    expect({ listedInAgents: inDocsDir, listedInRule2: inDocsDir }).toEqual({
      listedInAgents,
      listedInRule2,
    });
  });
});
