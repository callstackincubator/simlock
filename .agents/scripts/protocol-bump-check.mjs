#!/usr/bin/env node
// `node .agents/scripts/protocol-bump-check.mjs [--base <ref>] [--head <ref>]`: the mechanical
// half of the contract-shape rule in toolchain.md. Since <head> (default HEAD) left <base>
// (default origin/main), a code line changed in a contract shape file under src/contract/ and
// a change to PROTOCOL_VERSION_RANGE in src/contract/protocol.ts go together: one without the
// other is printed and the exit code is 1. Shape files are every src/contract/*.ts but tests,
// index.ts and the helpers in NOT_SHAPES. A commit in the range with the trailer
// `Protocol-bump: none (<reason>)` lets a contract edit that changes no wire shape through (a
// refactor, a client-only error code); whether the reason holds is the review's question.
import { execFileSync } from "node:child_process";

const PROTOCOL = "src/contract/protocol.ts";
const NOT_SHAPES = new Set([
  "index.ts",
  "console-url.ts",
  "duration.ts",
  "os-range.ts",
  "version-order.ts",
]);
const RANGE = /PROTOCOL_VERSION_RANGE[^=]*=\s*\{\s*min:\s*(\d+),\s*max:\s*(\d+)/;
const TRAILER = /^Protocol-bump: none \(.+\)\s*$/m;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });

const head = option("--head", "HEAD");
const base = git("merge-base", option("--base", "origin/main"), head).trim();

function range(rev) {
  const match = RANGE.exec(git("show", `${rev}:${PROTOCOL}`));
  return match === null ? "none" : `${match[1]}..${match[2]}`;
}

function isShape(file) {
  const name = file.slice("src/contract/".length);
  return (
    !name.includes("/") &&
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    !NOT_SHAPES.has(name)
  );
}

function changesCode(file) {
  return git("diff", "-U0", "-w", base, head, "--", file)
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
    .map((line) => line.slice(1).trim())
    .some((line) => line !== "" && !/^(\/\/|\/\*|\*)/.test(line) && !RANGE.test(line));
}

const shapes = git("diff", "--name-only", base, head, "--", "src/contract/")
  .split("\n")
  .filter((file) => file !== "" && isShape(file) && changesCode(file));
const before = range(base);
const after = range(head);
const waived = TRAILER.test(git("log", "--format=%B", `${base}..${head}`));

if (shapes.length > 0 && before === after && !waived) {
  console.log(
    `${shapes.join(", ")}: contract shape changed, but PROTOCOL_VERSION_RANGE stays ${after}. ` +
      `Bump it by one in ${PROTOCOL}, or add the trailer "Protocol-bump: none (<reason>)" to a commit.`,
  );
  process.exit(1);
}
if (shapes.length === 0 && before !== after) {
  console.log(
    `${PROTOCOL}: PROTOCOL_VERSION_RANGE moves ${before} to ${after} with no contract shape change.`,
  );
  process.exit(1);
}
