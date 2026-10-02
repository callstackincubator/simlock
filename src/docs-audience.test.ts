import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  .filter((name) => name.length > 0);

/** `README.md` and every markdown file under `docs/` that is not under `docs/internal/`. */
const endUserDocs = trackedFiles.filter(
  (name) =>
    name === "README.md" ||
    (name.startsWith("docs/") && !name.startsWith("docs/internal/") && name.endsWith(".md")),
);

/**
 * File names that exist only under `docs/internal/`. `EVENTS.md` and `README.md` are left out:
 * an end-user doc of the same name exists, so the bare name says nothing about the audience.
 */
const internalOnlyNames = [
  ...new Set(
    trackedFiles
      .filter((name) => name.startsWith("docs/internal/") && name.endsWith(".md"))
      .map((name) => basename(name)),
  ),
].filter((name) => !endUserDocs.some((doc) => basename(doc) === name));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What documentation rule 2 forbids an end-user doc from naming. */
const FORBIDDEN: RegExp[] = [
  /docs\/internal\b/,
  /\]\((?:\.\/)?internal\//,
  /\bADRs?\b/,
  /\badr\//,
  ...internalOnlyNames.map((name) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`)),
];

/**
 * Documentation rule 2 (`docs/internal/agent-rules/documentation.md`): an end-user doc never
 * cites an ADR and never points into `docs/internal/` -- by link, by path, or by an internal
 * doc's bare file name ("see ARCHITECTURE.md").
 */
describe("end-user docs", () => {
  it("were enumerated from the git index", () => {
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
