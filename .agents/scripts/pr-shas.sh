#!/usr/bin/env sh
# Prints, in one call, the commits and states a delivery step needs about a PR, read fresh:
#
#   .agents/scripts/pr-shas.sh <pr>
#
# Fetches origin quietly first, then prints one line each:
#
#   base <sha>          the tip of origin/<base branch> now (not the PR's stored base sha)
#   merge-base <sha>    git merge-base of that tip and the head
#   head <sha>          the PR's head commit on GitHub
#   base-ref <branch>   the PR's base branch
#   mergeable <v>       true, false, or null while GitHub has not computed it
#   draft <bool>        true or false
#   ci <state> for <sha>  the head's check runs and statuses, in merge-pr.sh's buckets: pending
#                       when any is not finished, fail when any failed or was cancelled, pass
#                       when all passed or were skipped, none when there are none
#   stack #a -> #b      the open PRs of its GitHub stack, bottom to top; left out when unstacked
#
# A value it cannot read prints as `unknown`. Exits 0 always: it reports, it decides nothing.
# The repo is GH_REPO, else the origin remote's owner/name.
set -u

pr=${1:-}
case $pr in '' | *[!0-9]*) echo "usage: pr-shas.sh <pr>" >&2; exit 0 ;; esac
# why: a cloud session's GitHub proxy refuses GraphQL, which `gh pr view` uses, so this script
# calls repo-scoped REST only.
nwo=${GH_REPO:-$(git remote get-url origin | sed -E 's#\.git$##; s#.*[/:]([^/:]+/[^/]+)$#\1#')}
api() {
  at=$1
  shift
  gh api -X GET "repos/$nwo/$at" "$@" 2>/dev/null
}
or_unknown() { [ -n "$1" ] && echo "$1" || echo unknown; }

git fetch -q origin 2>/dev/null
info=$(api "pulls/$pr" -q '"\(.head.sha) \(.base.ref) \(.draft) \(.mergeable) \(.state)"')
set -- $info
head=${1:-unknown} ref=${2:-unknown} draft=${3:-unknown} mergeable=${4:-unknown} state=${5:-}
# why: GitHub computes mergeability lazily; `null` (not computed yet) settles within seconds on
# an open PR, and stays null on a closed one.
for _ in 1 2 3; do
  [ "$mergeable" = null ] && [ "$state" = open ] || break
  sleep 2
  mergeable=$(or_unknown "$(api "pulls/$pr" -q '.mergeable | tostring')")
done
git fetch -q origin "+refs/pull/$pr/head:refs/pr-shas/$pr" 2>/dev/null
base=$(or_unknown "$(git rev-parse -q --verify "origin/$ref^{commit}" 2>/dev/null)")
fork=$(or_unknown "$(git merge-base "$base" "refs/pr-shas/$pr" 2>/dev/null)")
git update-ref -d "refs/pr-shas/$pr" 2>/dev/null

echo "base $base"
echo "merge-base $fork"
echo "head $head"
echo "base-ref $ref"
echo "mergeable $mergeable"
echo "draft $draft"

# why: `gh api --paginate` follows Link headers to numeric-ID repository URLs, which the proxy
# also refuses, so pages are requested by number. The filter must print one line per item.
paged() {
  at=$1 filter=$2 page=1
  while :; do
    batch=$(api "$at" -f per_page=100 -f page="$page" -q "$filter") || return 1
    [ -z "$batch" ] || printf '%s\n' "$batch"
    [ "$(printf '%s' "$batch" | grep -c '')" -ge 100 ] || return 0
    page=$((page + 1))
  done
}
ci=unknown
if [ "$head" != unknown ] &&
  buckets=$(paged "commits/$head/check-runs" '.check_runs[] | if .status != "completed" then
    "pending" elif .conclusion == "success" or .conclusion == "neutral" or .conclusion ==
    "skipped" then "pass" else "fail" end') &&
  statuses=$(paged "commits/$head/status" '.statuses[] | if .state == "pending" then "pending"
    elif .state == "success" then "pass" else "fail" end'); then
  all=$(printf '%s\n%s\n' "$buckets" "$statuses" | grep .)
  if [ -z "$all" ]; then ci=none
  elif echo "$all" | grep -qx pending; then ci=pending
  elif echo "$all" | grep -qx fail; then ci=fail
  else ci=pass
  fi
fi
echo "ci $ci for $head"

stack=$(api "stacks?pull_request=$pr" \
  -q '[.[] | select(.open)][0].pull_requests // [] | .[] | select(.state == "open") | "#\(.number)"')
[ -z "$stack" ] || echo "stack $(echo "$stack" | tr '\n' ' ' | sed 's/ $//; s/ / -> /g')"
exit 0
