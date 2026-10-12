#!/usr/bin/env sh
# SessionStart hook: exports CLAUDE_SESSION_ID and CLAUDE_TRANSCRIPT_PATH into the session's
# shell, so `node .agents/scripts/usage.mjs` can read the session's own usage without being
# told where its transcript is. Claude Code passes the session as JSON on stdin and sources
# $CLAUDE_ENV_FILE afterwards. Prints nothing.
set -eu

[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const o = JSON.parse(s || "{}");
    const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    if (o.session_id) console.log(`export CLAUDE_SESSION_ID=${q(o.session_id)}`);
    if (o.transcript_path) console.log(`export CLAUDE_TRANSCRIPT_PATH=${q(o.transcript_path)}`);
  });
' >>"$CLAUDE_ENV_FILE"
