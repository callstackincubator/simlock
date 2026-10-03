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

deadline=$(($(date +%s) + 1800))
while :; do
  checks=$(gh pr checks "$pr" --json name,bucket -q '.[] | "\(.bucket) \(.name)"' || true)
  [ -n "$checks" ] || fail "PR #$pr has no CI checks"
  echo "$checks" | grep -q '^pending ' || break
  [ "$(date +%s)" -lt "$deadline" ] || {
    echo "not merged: checks still pending after 30 minutes" >&2
    exit 2
  }
  sleep 30
done
bad=$(echo "$checks" | grep -v -e '^pass ' -e '^skipping ' || true)
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
