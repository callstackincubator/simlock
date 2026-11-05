#!/usr/bin/env node
// SessionStart hook: says when the session's checkout is behind origin/main, so the session
// (and every sub-agent it hands the path to) knows the code it reads there may not be main's. A
// session asked about "today's" behaviour in a worktree left on an older branch answered with
// that branch's code. Fetches main first, for at most FETCH_MS; offline, it counts against the
// last fetch and says so. Prints nothing when the checkout has all of main, or is no git
// checkout with an origin.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const FETCH_MS = 10_000;

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {}
const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();

const git = (args, timeout) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });

const fetched = git(["fetch", "-q", "origin", "main"], FETCH_MS).status === 0;
const count = git(["rev-list", "--count", "HEAD..origin/main"]);
const behind = Number(count.stdout.trim());
if (count.status !== 0 || !(behind > 0)) process.exit(0);

const branch = git(["branch", "--show-current"]).stdout.trim() || "a detached HEAD";
const when = fetched ? "" : " (as of the last fetch; this one failed)";
console.log(
  `This checkout (${branch}) is ${behind} commit${behind === 1 ? "" : "s"} behind origin/main${when}. ` +
    "Code read here may differ from main's: for today's behaviour read `git show origin/main:<path>`, " +
    "and say so to any sub-agent you give this path.",
);
