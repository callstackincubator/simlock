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

/** A markdown file by extension, in any case: `.md` or `.markdown`. */
const isMarkdown = (name: string) => /\.(?:md|markdown)$/i.test(name);

const WEBSITE_DOCS = "website/src/content/docs/";

const endUserDocs = trackedFiles.filter(
  (name) =>
    name === "README.md" || (name.startsWith(WEBSITE_DOCS) && /\.(?:mdx?|markdown)$/i.test(name)),
);

/**
 * why: File names under `docs/internal/`. `README.md` is left out: the repo's own `README.md` is an
 * end-user doc, so the bare name says nothing about the audience.
 */
const internalOnlyNames = [
  ...new Set(
    trackedFiles
      .filter((name) => name.startsWith("docs/internal/") && isMarkdown(name))
      .map((name) => basename(name)),
  ),
].filter((name) => name !== "README.md");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const internalName = (name: string) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "i");

/** What documentation rule 2 forbids an end-user doc from naming. */
const FORBIDDEN: RegExp[] = [
  /docs\/internal\b/,
  // why: `internal/` starting a path: a link or a path in backticks or prose.
  /(?<![\w./-])(?:\.\/)?internal\//,
  /\bADRs?\b/i,
  /\bdecision records?\b/i,
  ...internalOnlyNames.map(internalName),
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
        `${WEBSITE_DOCS}docs/introduction/index.mdx`,
        `${WEBSITE_DOCS}docs/reference/cli.mdx`,
        `${WEBSITE_DOCS}docs/reference/events.mdx`,
      ]),
    );
    expect(internalOnlyNames).toEqual(
      expect.arrayContaining(["ARCHITECTURE.md", "DELIVERY.md", "EVENTS.md", "testing.md"]),
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

    // why: `EVENTS.md` and `events.md` both match either spelling; report a hit once.
    expect([...new Set(offenders)]).toEqual([]);
  });
});

/**
 * why: Documentation rule 1: the website holds every end-user doc, and `docs/` holds only
 * `docs/internal/`. A markdown file anywhere else under `docs/` is a doc in the wrong place.
 */
describe("the markdown files under docs/", () => {
  it("all sit under docs/internal/", () => {
    expect(
      trackedFiles.filter(
        (name) =>
          name.startsWith("docs/") && !name.startsWith("docs/internal/") && isMarkdown(name),
      ),
    ).toEqual([]);
  });
});
