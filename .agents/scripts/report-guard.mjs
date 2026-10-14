#!/usr/bin/env node
// SubagentStop hook: a delivery stage agent may not stop before its last message is its report
// block. The block's first key names the agent:
//
//   implementer         issue: <N> ...
//   reviewer            PR: #<M>  Round: ...
//   hardware-verifier   PR: #<M>  Hardware: ...
//
// An implementer's `mode: audit` report must also hold its `audit:` line: an audit given fixes
// as well once did the fixes and skipped the audit. That line's `probed <p>/<t>` must show every
// test it added or changed probed: audits that skipped the probe left half of all review
// findings to the reviewers. Other agents stop freely. Claude Code ends the turn anyway after
// eight blocks in a row.
import fs from "node:fs";

const REPORT = {
  implementer: /^issue: \d+/m,
  reviewer: /^PR: #\d+\s+Round:/m,
  "hardware-verifier": /^PR: #\d+\s+Hardware:/m,
};

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const shape = REPORT[input.agent_type];
const message = input.last_assistant_message ?? "";
if (shape === undefined) process.exit(0);

if (!shape.test(message)) {
  block(
    "You stopped without your report block. If a helper agent or a command you started is " +
      "still running, wait for it in the foreground. Then finish the work and end with the " +
      "report block your instructions define, and nothing after it.",
  );
} else if (/\bmode: audit\b/.test(message)) {
  const audit = /^audit: .*$/m.exec(message);
  const probed = audit === null ? null : /\bprobed (\d+)\/(\d+)/.exec(audit[0]);
  if (audit === null) {
    block(
      "Your report is an audit's but has no `audit:` line, so the audit did not run. Do the " +
        "audit in implement-audit.md on the whole diff, then report again with its `audit:` line.",
    );
  } else if (probed === null) {
    block(
      "Your `audit:` line has no `probed` count. Probe every test you added or changed as " +
        "implement-audit.md says, then report again with `probed <probed>/<tests>`.",
    );
  } else if (Number(probed[1]) < Number(probed[2])) {
    block(
      `You probed ${probed[1]} of ${probed[2]} tests. Probe the rest as implement-audit.md ` +
        "says: break the code each covers, run its file, see it fail on its assertion, restore.",
    );
  }
}

function block(reason) {
  console.log(JSON.stringify({ decision: "block", reason }));
}
