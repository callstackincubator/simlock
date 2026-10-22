#!/usr/bin/env sh
# Merges a delivery PR only when its mechanical gates pass (delivery rule 15).
#
#   .agents/scripts/merge-pr.sh <pr>
#
# A PR in a stack (a feature's task PRs, delivery rule 15) is merged with every PR below it, so
# every one of them must pass the gates; `gh stack merge` then merges them bottom to top, all or
# nothing. Gates, in order, for each: the PR is open and not a draft; it carries no needs-hardware label; its body
# passes pr-body-check.mjs (a `## Review` section with its counts line, no "spec needs" line,
# the agent footer); every CI check passed or was skipped; and GitHub calls it mergeable. Waits up to 30 minutes for pending checks. Prints the first gate
# that fails and exits 1, or exits 2 when checks are still pending at the deadline.
#
# Red CI gets one re-run of its failed jobs when no failure is this PR's to fix: every red
# check is a job GitHub cancelled (no runner came), or every test that failed is named by an
# open `flaky-test` issue (testing rule 5). MERGE_PR_POLL_SECONDS sets the poll interval.
# The repo is GH_REPO, else the origin remote's owner/name.
#
# Agents may not run `gh pr merge` themselves (.claude/settings.json); this script is the one
# place a delivery PR is merged from.
set -eu

target=${1:?usage: merge-pr.sh <pr>}
fail() {
  echo "not merged: $*" >&2
  exit 1
}

# why: a cloud session's GitHub proxy refuses GraphQL, which `gh pr`, `gh issue` and
# `gh repo view` use, so this script calls repo-scoped REST only.
nwo=${GH_REPO:-$(git remote get-url origin | sed -E 's#\.git$##; s#.*[/:]([^/:]+/[^/]+)$#\1#')}
api() {
  at=$1
  shift
  gh api -X GET "repos/$nwo/$at" "$@"
}
pull() { api "pulls/$pr" -q "$1"; }

# why: `gh api --paginate` follows Link headers to numeric-ID repository URLs, which the proxy
# also refuses, so pages are requested by number. The filter must print one line per item.
paged() {
  at=$1 filter=$2 page=1
  while :; do
    batch=$(api "$at" -f per_page=100 -f page="$page" -q "$filter")
    [ -z "$batch" ] || printf '%s\n' "$batch"
    [ "$(printf '%s' "$batch" | grep -c '')" -ge 100 ] || return 0
    page=$((page + 1))
  done
}

poll=${MERGE_PR_POLL_SECONDS:-30}

# why: each line is `<bucket> <link> <name>` in the buckets `gh pr checks` printed, so a red
# check reads as it did before the port to REST; `-` stands for a missing link.
checks() {
  sha=$(pull .head.sha)
  paged "commits/$sha/check-runs" '.check_runs[] | (if .status != "completed" then "pending"
    elif .conclusion == "success" or .conclusion == "neutral" then "pass"
    elif .conclusion == "skipped" then "skipping" elif .conclusion == "cancelled" then "cancel"
    else "fail" end) + " " + (.details_url // "-") + " " + .name'
  paged "commits/$sha/status" '.statuses[] | (if .state == "pending" then "pending"
    elif .state == "success" then "pass" else "fail" end) + " " + (.target_url // "-") + " " + .context'
}

# Waits for every check to settle, then sets `bad` to the ones that did not pass or skip.
# Called directly, never in $( ), so its exits end the script.
red_checks() {
  deadline=$(($(date +%s) + 1800))
  while :; do
    all=$(checks)
    checks=$(printf '%s' "$all" | sed 's/^\([^ ]*\) [^ ]* /\1 /')
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
  flaky=$(api issues -f labels=flaky-test -f state=open -f per_page=100 \
    -q '.[] | select(.pull_request == null) | .title, .body // ""' |
    grep -oE '(e2e|src|ui)/[A-Za-z0-9_./-]+\.(test|spec)\.tsx?' || true)
  red=$(checks | grep -e '^fail ' -e '^cancel ' || true)
  others=$(echo "$red" | sed 's/^[^ ]* [^ ]* //' | grep -vxE 'Quality|Console' || true)
  echo "$red" | grep . |
    while read -r bucket link name; do
      # why: Quality and Console only sum up the CI jobs they need and fail when one was
      # cancelled, so next to a red job, judging them would call that job's cancel this PR's to
      # fix. Red alone, they were cancelled themselves and are re-run like any job.
      case $name in Quality | Console) [ -z "$others" ] || continue ;; esac
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

gates() {
  [ "$(pull .state)" = open ] || fail "PR #$pr is not open"
  [ "$(pull '.draft | tostring')" = false ] || fail "PR #$pr is still a draft"
  pull '.labels[].name' | grep -qx needs-hardware && fail "PR #$pr is labelled needs-hardware"
  node "$(dirname "$0")/pr-body-check.mjs" "$pr" || fail "PR #$pr body fails pr-body-check.mjs (above)"

  red_checks
  if [ -n "$bad" ]; then
    runs=$(rerunnable_runs)
    if [ -n "$runs" ] && ! echo "$runs" | grep -qx none; then
      echo "PR #$pr: re-running the failed jobs once: cancelled, or failed only on open flaky-test issues"
      for run in $runs; do gh run rerun "$run" --failed; done
      sleep "$poll"
      red_checks
    fi
  fi
  [ -z "$bad" ] || fail "CI not green on PR #$pr: $(echo "$bad" | tr '\n' ';')"

  # why: GitHub computes mergeability lazily; `null` (not computed yet) settles within seconds.
  for _ in 1 2 3 4 5 6; do
    mergeable=$(pull '.mergeable | tostring')
    [ "$mergeable" = null ] || break
    sleep $((poll < 5 ? poll : 5))
  done
  case $mergeable in
    true) ;;
    null) fail "GitHub has not computed whether PR #$pr is mergeable" ;;
    *) fail "GitHub reports PR #$pr as not mergeable" ;;
  esac
}

stack=$(api "stacks?pull_request=$target" \
  -q '[.[] | select(.open)][0].pull_requests // [] | .[] | select(.state == "open") | .number')
members=$(echo "$stack" | sed "/^$target\$/q")
[ -n "$members" ] || members=$target
for pr in $members; do gates; done

if [ "$members" = "$target" ]; then
  if ! out=$(gh api -X PUT "repos/$nwo/pulls/$target/merge" -f merge_method=squash 2>&1); then
    # why: the last open PR of a stack whose lower PRs merged is still stacked, and GitHub
    # refuses a plain merge of a stacked PR.
    case $out in
      *stack*) gh stack merge "$target" --yes --squash ;;
      *) fail "$out" ;;
    esac
  fi
else
  gh stack merge "$target" --yes --squash
fi
echo "merged #$(echo "$members" | tr '\n' ' ' | sed 's/ $//; s/ / #/g')"
