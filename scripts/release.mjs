#!/usr/bin/env node
// `node scripts/release.mjs <command>`: the parts of the Release workflow (.github/workflows/release.yml)
// that compute or edit something, kept out of the YAML so they are tested (src/release-script.test.ts)
// and can be run by hand. Every command reads and writes the current directory's package.json and
// CHANGELOG.md.
//
//   plan --bump auto|feature|patch   Prints the next version, its tag and the bump it chose as
//                                    `key=value` lines, from package.json's version and the commit
//                                    messages since the last release on stdin. There is no semver:
//                                    `feature` moves 0.X, `patch` moves 0.X.Y, and `auto` is `feature`
//                                    when a message is a `feat` or a breaking change, else `patch`.
//                                    No message at all is a failure: there is nothing to release.
//   bump <version>                   Writes the version into package.json.
//   changelog <version> <previous-tag> <notes-file>
//                                    Inserts the release's section into CHANGELOG.md, above the first
//                                    released section, from the notes file (GitHub's generated
//                                    notes); an empty previous tag means the first release.
import { readFileSync, writeFileSync } from "node:fs";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;
const BUMPS = ["auto", "feature", "patch"];
// why: a `!` before the colon marks a break on any type, not only `feat`, so a line of any type
// with it is a feature too.
const FEATURE = /^(?:feat(?:\([^)]*\))?!?: |[a-z]+(?:\([^)]*\))?!: |BREAKING CHANGE:)/u;

function parseVersion(version, what) {
  const match = VERSION.exec(version ?? "");
  if (match === null) throw new Error(`${what} is not <major>.<minor>.<patch>: ${version}`);
  return match.slice(1).map(Number);
}

function nextVersion(current, bump) {
  const [major, minor, patch] = parseVersion(current, "package.json's version");
  return bump === "feature" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function chosenBump(bump, messages) {
  if (bump !== "auto") return bump;
  return messages.split("\n").some((line) => FEATURE.test(line)) ? "feature" : "patch";
}

function changelogWithRelease(changelog, { version, previousTag, notes, repository, date }) {
  const title =
    previousTag === ""
      ? `## ${version} (${date})`
      : `## [${version}](${repository}/compare/${previousTag}...v${version}) (${date})`;
  // why: GitHub's notes start at `## What's Changed`, the level the version heading has.
  const body = notes.trim().replace(/^## /gmu, "### ");
  const section = `${title}\n\n${body}\n\n`;
  const lines = changelog.split("\n");
  const first = lines.findIndex((line) => /^## \[?\d+\.\d+\.\d+/u.test(line));
  if (first === -1) return `${changelog.replace(/\n*$/u, "\n\n")}${section.trimEnd()}\n`;
  lines.splice(first, 0, ...section.split("\n").slice(0, -1));
  return lines.join("\n");
}

function readPackage() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

function plan(args) {
  const at = args.indexOf("--bump");
  const bump = at === -1 ? undefined : args[at + 1];
  if (!BUMPS.includes(bump)) throw new Error(`plan needs --bump ${BUMPS.join("|")}`);
  const messages = readFileSync(0, "utf8");
  if (messages.trim() === "") {
    throw new Error("no commit since the last release: nothing to release");
  }
  const chosen = chosenBump(bump, messages);
  const version = nextVersion(readPackage().version, chosen);
  process.stdout.write(`version=${version}\ntag=v${version}\nbump=${chosen}\n`);
}

function bump([version]) {
  parseVersion(version, "the version to write");
  const pkg = readPackage();
  pkg.version = version;
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

function changelog([version, previousTag = "", notesFile]) {
  parseVersion(version, "the released version");
  if (notesFile === undefined) throw new Error("changelog needs a notes file");
  const repository = readPackage().repository.url.replace(/\.git$/u, "");
  const updated = changelogWithRelease(readFileSync("CHANGELOG.md", "utf8"), {
    version,
    previousTag,
    notes: readFileSync(notesFile, "utf8"),
    repository,
    date: new Date().toISOString().slice(0, 10),
  });
  writeFileSync("CHANGELOG.md", updated);
}

const commands = { plan, bump, changelog };
const [command, ...rest] = process.argv.slice(2);
const run = commands[command];
if (run === undefined) {
  console.error(
    "usage: release.mjs plan --bump <bump> | bump <version> | changelog <version> <previous-tag> <notes-file>",
  );
  process.exit(2);
}
try {
  run(rest);
} catch (error) {
  console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
