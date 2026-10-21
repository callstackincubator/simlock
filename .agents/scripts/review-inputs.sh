#!/usr/bin/env sh
# Builds the blind inputs for the pre-merge reviews of a PR (delivery rule 14) and prints the
# directory's path as the last line on stdout.
#
#   .agents/scripts/review-inputs.sh <pr> [<previous commit>]
#
# The directory holds, when each exists:
#
#   diff.patch             the PR's diff against its base, as GitHub shows it
#   commit                 the PR head the directory was built from
#   base, merge-base       immutable actual PR base tip and fork
#   previous               validated ancestor for targeted checks
#   review-protocol.md     review policy from the pinned base, when present
#   kind                   what .agents/scripts/diff-kind.mjs calls the diff: adr-only,
#                          docs-only, comments-only, tests-only, full or large; it sets which
#                          reviews run
#   fix.patch              with a previous commit: the diff from it to the head
#   stale-refs.txt         what .agents/scripts/stale-refs.sh finds for the PR: lines anywhere in
#                          the repo that still name something the diff removed
#   briefs/                every file in .agents/briefs/ as the base has it: each reviewer's
#                          brief, and calibration.md, the findings reviews raised lately that
#                          were rejected, which every reviewer reads first
#   issue.md               the issue the PR closes: the second segment of a <kind>/<n> branch,
#                          else the first "Closes #n" in the PR body
#   feature.md             the issue's parent: its GitHub parent, else its "Part of #n" line
#   triage.md              a bug's triage report: the last comment with a Simplest fix section
#   spec/                  every ADR that issue.md, feature.md, triage.md or the diff's ADR hunks
#                          name, as the base has it; every rule file listed under Rules in play;
#                          and, when there is an issue, always-in-scope.md
#   rules/                 every file in docs/internal/agent-rules/, and the ADR index as
#                          adr-index.md
#   tests-after-red.patch  each later change to a file a `test:` commit wrote (a build cycle's
#                          failing test, or a bug's reproduction), but a `test:` commit that
#                          only adds lines
#   assumptions.md         the PR body's `Assumption:` lines (coding rule 2)
#
# Nothing else: never the rest of the PR body, commit messages, or any other comment. Rules, ADRs
# and briefs come from the base branch, so a PR cannot rewrite what it is judged by. REVIEW_HEAD,
# REVIEW_BASE and REVIEW_RULES (below) replay a frozen snapshot. Whatever it looks
# for and cannot find, it says on stderr, with one summary line at the end. The repo is GH_REPO,
# else the origin remote's owner/name.
set -eu

pr=${1:-}
previous=${2:-}
case $pr in
  '' | *[!0-9]*)
    echo "usage: review-inputs.sh <pr number> [<previous commit>]" >&2
    exit 64
    ;;
esac
say() { echo "review-inputs: $*" >&2; }

# why: a cloud session's GitHub proxy refuses GraphQL, which `gh pr`, `gh issue` and
# `gh repo view` use, so this script calls repo-scoped REST only.
nwo=${GH_REPO:-$(git remote get-url origin | sed -E 's#\.git$##; s#.*[/:]([^/:]+/[^/]+)$#\1#')}
api() {
  at=$1
  shift
  gh api -X GET "repos/$nwo/$at" "$@"
}
head_ref=$(api "pulls/$pr" -q .head.ref)
base_ref=$(api "pulls/$pr" -q .base.ref)
pr_body=$(api "pulls/$pr" -q '.body // ""' | tr -d '\r')

# The PR head through GitHub's pull ref, which outlives a deleted branch. The temporary ref is
# per PR, so two reviews running at once do not overwrite each other's.

# why: a replay (REVIEW_HEAD and REVIEW_BASE, full SHAs, both or neither) reviews a frozen
# snapshot of a PR that may be merged and whose branches may be gone, so the SHAs must already be
# local (review-replay.sh fetches refs/replay/<pr>/...). REVIEW_RULES names the commit rules,
# briefs and the protocol come from instead of the base, so an old snapshot can be reviewed with
# new instructions; the ADRs and the spec still come from the base, as the PR was judged then.
if [ -n "${REVIEW_HEAD:-}${REVIEW_BASE:-}" ]; then
  if [ -z "${REVIEW_HEAD:-}" ] || [ -z "${REVIEW_BASE:-}" ]; then
    say "REVIEW_HEAD and REVIEW_BASE go together"
    exit 64
  fi
  head=$(git rev-parse --verify "$REVIEW_HEAD^{commit}" 2>/dev/null) || {
    say "REVIEW_HEAD $REVIEW_HEAD is not a local commit"
    exit 65
  }
  base=$(git rev-parse --verify "$REVIEW_BASE^{commit}" 2>/dev/null) || {
    say "REVIEW_BASE $REVIEW_BASE is not a local commit"
    exit 65
  }
  say "replay: head $head, base $base"
else
  git fetch -q origin "+refs/heads/$base_ref:refs/remotes/origin/$base_ref"
  git fetch -q origin "+refs/pull/$pr/head:refs/review-inputs/$pr"
  head=$(git rev-parse "refs/review-inputs/$pr")
  git update-ref -d "refs/review-inputs/$pr"
  base=$(git rev-parse "origin/$base_ref")
fi
rules_ref=${REVIEW_RULES:-$base}
if [ -n "${REVIEW_RULES:-}" ]; then
  rules_ref=$(git rev-parse --verify "$REVIEW_RULES^{commit}" 2>/dev/null) || {
    say "REVIEW_RULES $REVIEW_RULES is not a local commit"
    exit 65
  }
  say "rules, briefs and the protocol from $rules_ref"
fi
fork=$(git merge-base "$base" "$head")
if [ -n "$previous" ]; then
  previous=$(git rev-parse --verify "$previous^{commit}" 2>/dev/null) || {
    say "previous commit is unavailable; assessment incomplete"
    exit 65
  }
  git merge-base --is-ancestor "$previous" "$head" || {
    say "previous commit is not an ancestor of head; assessment incomplete"
    exit 65
  }
fi

tmp=${TMPDIR:-/tmp}
out=$(mktemp -d "${tmp%/}/review-$pr.XXXXXX")
mkdir "$out/spec" "$out/rules"

git diff "$fork" "$head" >"$out/diff.patch"
echo "$head" >"$out/commit"
echo "$base" >"$out/base"
echo "$fork" >"$out/merge-base"
[ -z "$previous" ] || echo "$previous" >"$out/previous"
if git cat-file -e "$rules_ref:docs/internal/REVIEW.md" 2>/dev/null; then
  git show "$rules_ref:docs/internal/REVIEW.md" >"$out/review-protocol.md"
fi
node "$(dirname "$0")/diff-kind.mjs" "$fork" "$head" >"$out/kind"
if [ -n "$previous" ]; then
  git diff "$previous" "$head" >"$out/fix.patch"
fi
"$(dirname "$0")/stale-refs.sh" "$fork" "$head" >"$out/stale-refs.txt"
# Always written, so a reviewer can tell "the sweep found nothing" from "the sweep did not run".
[ -s "$out/stale-refs.txt" ] || echo "(the sweep found no line naming anything the diff removed)" >"$out/stale-refs.txt"
mkdir "$out/briefs"
for f in $(git ls-tree --name-only "$rules_ref" .agents/briefs/); do
  git show "$rules_ref:$f" >"$out/briefs/$(basename "$f")"
done

for f in $(git ls-tree --name-only "$rules_ref" docs/internal/agent-rules/); do
  git show "$rules_ref:$f" >"$out/rules/$(basename "$f")"
done
git show "$rules_ref:docs/internal/adr/README.md" >"$out/rules/adr-index.md"

issue=
case $head_ref in
  bug/* | feature/* | task/*)
    n=${head_ref#*/}
    case $n in '' | *[!0-9]*) ;; *) issue=$n ;; esac
    ;;
esac
if [ -z "$issue" ]; then
  issue=$(printf '%s\n' "$pr_body" \
    | grep -oiE '(^|[^[:alnum:]])(close[sd]?|fix(e[sd])?|resolve[sd]?):? +#[0-9]+' \
    | head -n 1 | grep -oE '[0-9]+$' || true)
fi

parent= play= rules= assumed=0
if [ -n "$issue" ]; then
  api "issues/$issue" -q '.body // ""' | tr -d '\r' >"$out/issue.md"
  labels=$(api "issues/$issue" -q '.labels[].name')

  parent=$(api "issues/$issue" -q '.parent_issue_url // empty' 2>/dev/null || true)
  parent=${parent##*/}
  if [ -z "$parent" ]; then
    parent=$(grep -m 1 -oE '^Part of #[0-9]+' "$out/issue.md" | grep -oE '[0-9]+' || true)
  fi
  if [ -n "$parent" ]; then
    api "issues/$parent" -q '.body // ""' | tr -d '\r' >"$out/feature.md"
  fi

  if printf '%s\n' "$labels" | grep -q '^bug:'; then
    # why: `gh api --paginate` follows Link headers to numeric-ID repository URLs, which the
    # proxy also refuses, so pages are requested by number. Each page prints its length first.
    page=1 triage=
    while :; do
      got=$(api "issues/$issue/comments" -f per_page=100 -f page="$page" -q 'length,
        ([.[] | select((.body // "") | test("(^|\n)## Simplest fix"))] | last | .body // empty)')
      last=$(printf '%s\n' "$got" | tail -n +2)
      [ -z "$last" ] || triage=$last
      [ "$(printf '%s\n' "$got" | head -n 1)" -ge 100 ] || break
      page=$((page + 1))
    done
    [ -z "$triage" ] || printf '%s\n' "$triage" | tr -d '\r' >"$out/triage.md"
    if [ ! -s "$out/triage.md" ]; then
      rm -f "$out/triage.md"
      say "bug #$issue has no triage report (no comment with a '## Simplest fix' section)"
    fi
  fi

  # Rule files under a "Rules in play" heading of the issue or its parent, up to the next
  # heading: `events.md`, or "architecture rule 13".
  for f in "$out/issue.md" "$out/feature.md"; do
    [ -f "$f" ] || continue
    play="$play$(awk '
      /^#+[ \t]/ { inside = ($0 ~ /^#+[ \t]+Rules in play[ \t]*$/); next }
      inside { print }
    ' "$f")"
  done
  for f in "$out"/rules/*.md; do
    name=$(basename "$f" .md)
    [ "$name" != adr-index ] || continue
    if printf '%s\n' "$play" | grep -qiE "(^|[^[:alnum:]-])$name(\.md|[[:space:]]+rules?)([^[:alnum:]-]|$)"; then
      cp "$f" "$out/spec/$name.md"
      rules="$rules $name"
    fi
  done
  if [ -z "$play" ]; then
    say "no Rules in play in #$issue${parent:+ or #$parent}"
  elif [ -z "$rules" ]; then
    say "Rules in play names no file in docs/internal/agent-rules/"
  fi

  if [ -f "$out/rules/always-in-scope.md" ]; then
    cp "$out/rules/always-in-scope.md" "$out/spec/always-in-scope.md"
  else
    say "docs/internal/agent-rules/always-in-scope.md is not on $base"
  fi

  printf '%s\n' "$pr_body" \
    | grep -E '^[[:space:]]*([-*][[:space:]]+)?Assumption:' >"$out/assumptions.md" || true
  if [ -s "$out/assumptions.md" ]; then
    assumed=$(grep -c . "$out/assumptions.md")
  else
    rm -f "$out/assumptions.md"
  fi
else
  say "PR #$pr closes no issue (branch $head_ref, no 'Closes #n' in the body)"
fi

# ADRs by number, wherever the spec names them, or wherever the record an ADR diff adds or edits
# names them: "ADR 0014", "ADR-0014", "ADRs 0004 and 0005", or a link to adr/0014-....md. Each
# comes as the base has it; one this diff adds is in diff.patch alone.
changed_adrs=$(git diff --name-only "$fork" "$head" -- docs/internal/adr/ \
  | grep -oE 'adr/[0-9]{4}-' | grep -oE '[0-9]{4}' || true)
adrs=$({
  cat "$out/issue.md" "$out/feature.md" "$out/triage.md" 2>/dev/null || true
  awk '
    /^diff --git / { adr = ($4 ~ /^b\/docs\/internal\/adr\/[0-9]/); next }
    adr && /^\+/ && !/^\+\+\+/ { print }
  ' "$out/diff.patch"
} | grep -oE 'ADRs?[ -]?[0-9]{4}((,? and |, | & |/)[0-9]{4})*|adr/[0-9]{4}-' \
  | grep -oE '[0-9]{4}' | sort -u || true)
for n in $adrs; do
  path=$(git ls-tree --name-only "$base" docs/internal/adr/ | grep "/$n-" | head -n 1 || true)
  if [ -n "$path" ]; then
    git show "$base:$path" >"$out/spec/$(basename "$path")"
  elif ! printf '%s\n' "$changed_adrs" | grep -qx "$n"; then
    say "ADR $n is named but is on neither $base nor this diff"
  fi
done

# why: the final diff hides a test deleted or loosened after it was first committed failing, so
# every later change to a file a `test:` commit wrote goes in, but a later `test:` commit that
# only adds lines: that is the next build cycle's test.
red=$(git log --reverse --format='%H %s' "$base..$head" | awk '$2 == "test:" { print $1; exit }')
if [ -n "$red" ]; then
  set -f
  written=" "
  : >"$out/tests-after-red.patch"
  for c in $(git rev-list --reverse --no-merges "$base..$head"); do
    files=$(git diff-tree --no-commit-id --name-only -r "$c")
    later=
    for f in $files; do
      case $written in *" $f "*) later="$later $f" ;; esac
    done
    subject=$(git log -1 --format=%s "$c")
    if [ -n "$later" ]; then
      removed=$(git diff --numstat "$c^" "$c" -- $later | awk '{ n += $2 } END { print n + 0 }')
      case $subject in
        test:*) [ "$removed" -eq 0 ] || git show --format='commit %H %s' "$c" -- $later ;;
        *) git show --format='commit %H %s' "$c" -- $later ;;
      esac >>"$out/tests-after-red.patch"
    fi
    case $subject in test:*) for f in $files; do written="$written$f "; done ;; esac
  done
  set +f
else
  say "no 'test:' commit on $head_ref: no tests-after-red.patch"
fi

say "#$pr at $(git rev-parse --short "$head"): issue ${issue:-none}, parent ${parent:-none}," \
  "ADRs $(ls "$out/spec" | grep -c '^[0-9]'), rules in play:${rules:- none}," \
  "assumptions $assumed, red commit $(if [ -n "$red" ]; then git rev-parse --short "$red"; else echo none; fi)"
echo "$out"
