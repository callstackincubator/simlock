#!/usr/bin/env sh
# Merges a delivery PR only when its mechanical gates pass (delivery rule 15).
#
#   .agents/scripts/merge-pr.sh <pr>
#
# Gates, in order: the PR is open and not a draft; it carries no needs-hardware label; its body
# has a `## Review` section and no "spec needs" line; every CI check passed or was skipped; and
# GitHub calls it mergeable. Waits up to 30 minutes for pending checks. Prints the first gate
# that fails and exits 1, or exits 2 when checks are still pending at the deadline.
#
# Red CI gets one re-run of its failed jobs when no failure is this PR's to fix: every red
# check is a job GitHub cancelled (no runner came), or every test that failed is named by an
# open `flaky-test` issue (testing rule 5). MERGE_PR_POLL_SECONDS sets the poll interval.
#
# Agents may not run `gh pr merge` themselves (.claude/settings.json); this script is the one
# place a delivery PR is merged from. A stacked PR is merged with `gh stack merge`, which merges
# everything below it too, bottom to top.
set -eu

pr=${1:?usage: merge-pr.sh <pr>}
fail() {
  echo "not merged: $*" >&2
  exit 1
}

view() { gh pr view "$pr" --json "$1" -q "$2"; }

[ "$(view state .state)" = OPEN ] || fail "PR #$pr is not open"
[ "$(view isDraft .isDraft)" = false ] || fail "PR #$pr is still a draft"
view labels '.labels[].name' | grep -qx needs-hardware && fail "PR #$pr is labelled needs-hardware"
body=$(view body .body)
printf '%s\n' "$body" | grep -q '^## Review' || fail "PR #$pr has no ## Review section"
printf '%s\n' "$body" | grep -qi 'spec needs' && fail "PR #$pr says the spec needs a change"

poll=${MERGE_PR_POLL_SECONDS:-30}

# Waits for every check to settle, then sets `bad` to the ones that did not pass or skip.
# Called directly, never in $( ), so its exits end the script.
red_checks() {
  deadline=$(($(date +%s) + 1800))
  while :; do
    checks=$(gh pr checks "$pr" --json name,bucket -q '.[] | "\(.bucket) \(.name)"' || true)
    [ -n "$checks" ] || fail "PR #$pr has no CI checks"
    echo "$checks" | grep -q '^pending ' || break
    [ "$(date +%s)" -lt "$deadline" ] || {
      echo "not merged: checks still pending after 30 minutes" >&2
      exit 2
    }
    sleep "$poll"
  done
  bad=$(echo "$checks" | grep -v -e '^pass ' -e '^skipping ' || true)
}

# Prints, one per line, the Actions run id of each red check, or `none` for a red check this PR
# must fix itself. A failed test is read from vitest's `FAIL` lines and Playwright's
# `[browser] ›` lines; a failed job with neither is this PR's to fix.
rerunnable_runs() {
  flaky=$(gh issue list --label flaky-test --state open --limit 100 --json title,body \
    -q '.[] | .title, .body' | grep -oE '(e2e|src|ui)/[A-Za-z0-9_./-]+\.(test|spec)\.tsx?' || true)
  gh pr checks "$pr" --json bucket,link -q '.[] | select(.bucket == "fail" or .bucket == "cancel") | "\(.bucket) \(.link)"' |
    while read -r bucket link; do
      run=$(echo "$link" | sed -n 's#.*/actions/runs/\([0-9][0-9]*\).*#\1#p')
      [ -n "$run" ] || { echo none; continue; }
      if [ "$bucket" = fail ]; then
        failed=$(gh run view "$run" --log-failed | grep -E ' FAIL |\) \[[a-z]+\] › ' |
          grep -oE '(e2e|src|ui)/[A-Za-z0-9_./-]+\.(test|spec)\.tsx?' | sort -u || true)
        [ -n "$failed" ] || { echo none; continue; }
        for f in $failed; do
          echo "$flaky" | grep -qxF "$f" || { echo none; continue 2; }
        done
      fi
      echo "$run"
    done | sort -u
}

red_checks
if [ -n "$bad" ]; then
  runs=$(rerunnable_runs)
  if [ -n "$runs" ] && ! echo "$runs" | grep -qx none; then
    echo "re-running the failed jobs once: cancelled, or failed only on open flaky-test issues"
    for run in $runs; do gh run rerun "$run" --failed; done
    sleep "$poll"
    red_checks
  fi
fi
[ -z "$bad" ] || fail "CI not green: $(echo "$bad" | tr '\n' ';')"

# GitHub computes mergeability lazily; UNKNOWN settles within seconds.
for _ in 1 2 3 4 5 6; do
  mergeable=$(view mergeable .mergeable)
  [ "$mergeable" = UNKNOWN ] || break
  sleep 5
done
[ "$mergeable" = MERGEABLE ] || fail "GitHub reports PR #$pr as $mergeable"

if ! out=$(gh pr merge "$pr" --squash 2>&1); then
  case $out in
    *stack*) gh stack merge "$pr" --yes --squash ;;
    *) fail "$out" ;;
  esac
fi
echo "merged #$pr"
