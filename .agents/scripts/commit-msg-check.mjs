#!/usr/bin/env node
// `node .agents/scripts/commit-msg-check.mjs <message file>`: the commit-msg hook's check of a
// subject on a delivery branch, in the shapes the build brief and the triager write. On
// `<kind>/<n>` the subject is `<type>(<scope>): <what> (#<n>)`, <type> one of feat, fix, test,
// docs, chore, refactor, perf, build, ci, the scope optional; another issue's number (a
// feature's, on an ADR commit in its stack) is a warning. On `bug/<n>-repro` it is `test:
// reproduce #<n> — <claim>`. Merge commits and every other branch pass. A failure exits 1 with
// the reason and the shape on stderr.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: commit-msg-check.mjs <message file>");
  process.exit(64);
}
const subject =
  readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.trim() !== "" && !l.startsWith("#")) ?? "";
let branch = "";
try {
  branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  process.exit(0);
}
if (subject.startsWith("Merge ")) process.exit(0);

const repro = /^bug\/(\d+)-repro$/.exec(branch);
if (repro !== null && !new RegExp(`^test: reproduce #${repro[1]} — .+`).test(subject)) {
  fail(`a commit on ${branch} is \`test: reproduce #${repro[1]} — <claim>\``);
}
const delivery = /^(?:bug|task|feature)\/(\d+)$/.exec(branch);
if (delivery !== null) {
  const shape =
    /^(?:feat|fix|test|docs|chore|refactor|perf|build|ci)(?:\([\w./-]+\))?: .+ \(#(\d+)\)$/.exec(
      subject,
    );
  if (shape === null) {
    fail(
      `a commit on ${branch} is \`<type>(<scope>): <what now works> (#${delivery[1]})\`, or ` +
        `\`test: <the Tests line's claim> (#${delivery[1]})\`; <type> is feat, fix, test, docs, ` +
        "chore, refactor, perf, build or ci",
    );
  }
  if (shape[1] !== delivery[1]) {
    console.error(
      `commit-msg: warning: the subject names #${shape[1]}, and the branch is ${branch}`,
    );
  }
}

function fail(reason) {
  console.error(`commit-msg: "${subject}" is refused: ${reason}.`);
  process.exit(1);
}
