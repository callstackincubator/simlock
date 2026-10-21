#!/usr/bin/env sh
# Re-reviews a frozen snapshot of a PR (replay-freeze.mjs) with the agents of this checkout, or
# with the rules, briefs and protocol of another commit:
#
#   .agents/scripts/review-replay.sh <pr> <round> [<rules commit>]
#   .agents/scripts/review-replay.sh --lens <spec|code|claims> <pr> <round> [<rules commit>]
#   REPLAY_LABEL=<label>   names the findings file, so repeated replays of one snapshot keep apart
#   REPLAY_LENS_SCOPE=<behaviour|tests|both>   the code lens's scope (default both)
#
# --lens replays one lens alone, the way the 2026-10-19 experiment did: it prints the prompt the
# coordinator would send that lens (a code lens also gets a prepared detached worktree at the
# head), so a question about one lens, or one model for it, is answered without the coordinator's
# own variance. The lens writes its report; score it by hand or from its report block.
#
# Fetches the pinned refs, builds the blind inputs for that exact head and base through
# review-inputs.sh, and prints the prompt to start the `reviewer` agent with. The ledger tag
# says stage=replay, so review-metrics.mjs leaves the run out of the PR's real numbers (and
# reports it with --replay). The reviewer writes its findings file where `findings:` says and
# posts nothing; score it with review-score.mjs --since <the started: line>, which keeps this
# replay's runs apart from earlier replays of the same snapshot.
set -eu
lens=
if [ "${1:-}" = --lens ]; then
  lens=${2:-}
  shift 2
  case $lens in spec | code | claims) ;; *) echo "usage: review-replay.sh --lens <spec|code|claims> <pr> <round> [<rules commit>]" >&2; exit 64 ;; esac
fi
pr=${1:-}
round=${2:-}
rules=${3:-}
case "$pr:$round" in *[!0-9]*:1 | *[!0-9]*:2 | *[!0-9]*:fix-check | :* | *:) ;; esac
if [ -z "$pr" ] || [ -z "$round" ]; then
  echo "usage: review-replay.sh <pr> <round> [<rules commit>]" >&2
  exit 64
fi
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
snapshot="$root/.agents/replay/$pr.json"
[ -f "$snapshot" ] || { echo "no snapshot: $snapshot (run replay-freeze.mjs first)" >&2; exit 66; }
read_sha() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rounds[process.argv[2]]; if(!s){process.exit(66)}; process.stdout.write(s[process.argv[3]]??"")' "$snapshot" "$round" "$1"; }
head=$(read_sha head) || { echo "snapshot has no round $round" >&2; exit 66; }
base=$(read_sha base)
previous=$(read_sha previous)
issue=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).issue??"-"))' "$snapshot")

git -C "$root" fetch -q origin "+refs/replay/$pr/$round/*:refs/replay/$pr/$round/*"
dir=$(cd "$root" && REVIEW_HEAD="$head" REVIEW_BASE="$base" REVIEW_RULES="$rules" .agents/scripts/review-inputs.sh "$pr" $previous | tail -n 1)
findings="$dir/replay-findings${REPLAY_LABEL:+-$REPLAY_LABEL}.json"
if [ -n "$lens" ]; then
  wt="${TMPDIR:-/tmp}/replay-$pr-$round-$lens${REPLAY_LABEL:+-$REPLAY_LABEL}"
  rm -rf "$wt"
  git -C "$root" worktree add -q --detach "$wt" "$head"
  if [ "$lens" = code ]; then
    "$here/worktree.sh" --prepare "$wt" >/dev/null
    scope=${REPLAY_LENS_SCOPE:-both}
    echo "ledger: pr=$pr issue=$issue stage=replay round=$round role=code lens=$scope"
    echo "Inputs dir: $dir"
    echo "Worktree (prepared, commit $head): $wt"
    echo "Round: $round. Lens: $scope."
  else
    echo "ledger: pr=$pr issue=$issue stage=replay round=$round role=$lens lens=-"
    echo "Inputs dir: $dir"
    echo "Read-only worktree (commit $head): $wt"
    echo "Round: $round. Lens: $lens."
  fi
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
cat <<PROMPT
ledger: pr=$pr issue=$issue stage=replay round=$round role=reviewer lens=-
pr: $pr
issue: $issue
round: $round
replay: true
inputs: $dir
commit: $head
base-sha: $base
merge-base: $(cat "$dir/merge-base")
${previous:+previous: $previous}
findings: $findings
started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
PROMPT
