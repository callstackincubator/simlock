#!/usr/bin/env sh
# Builds the blind inputs for the two pre-merge reviews of a PR (delivery rule 14) and prints
# the directory's path as the last line on stdout.
#
#   .agents/scripts/review-inputs.sh <pr>
#
# The directory holds, when each exists:
#
#   diff.patch             the PR's diff against its base, as GitHub shows it
#   issue.md               the issue the PR closes: the second segment of a <kind>/<n> branch,
#                          else the first "Closes #n" in the PR body
#   feature.md             the issue's parent: its GitHub parent, else its "Part of #n" line
#   triage.md              a bug's triage report: the last comment with a Simplest fix section
#   spec/                  every ADR that issue.md, feature.md or triage.md names, every rule file
#                          they list under Rules in play, and always always-in-scope.md
#   rules/                 every file in docs/internal/agent-rules/, and the ADR index as
#                          adr-index.md
#   tests-after-red.patch  what changed in the files of the branch's first `test:` commit (the
#                          red tests, or a bug's reproduction) between that commit and the head
#   assumptions.md         the PR body's `Assumption:` lines (delivery rule 3)
#
# Nothing else: never the rest of the PR body, commit messages, or any other comment. Rules and
# ADRs come from the base branch, so a PR cannot rewrite what it is judged by; only an ADR the
# base lacks (one this PR adds) comes from the PR head. Whatever it cannot find, it says on
# stderr, with one summary line at the end.
set -eu

pr=${1:-}
case $pr in
  '' | *[!0-9]*)
    echo "usage: review-inputs.sh <pr number>" >&2
    exit 64
    ;;
esac
say() { echo "review-inputs: $*" >&2; }

nwo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
head_ref=$(gh pr view "$pr" --json headRefName -q .headRefName)
base_ref=$(gh pr view "$pr" --json baseRefName -q .baseRefName)
pr_body=$(gh pr view "$pr" --json body -q .body | tr -d '\r')

# The PR head through GitHub's pull ref, which outlives a deleted branch. The temporary ref is
# per PR, so two reviews running at once do not overwrite each other's.
git fetch -q origin "+refs/heads/$base_ref:refs/remotes/origin/$base_ref"
git fetch -q origin "+refs/pull/$pr/head:refs/review-inputs/$pr"
head=$(git rev-parse "refs/review-inputs/$pr")
git update-ref -d "refs/review-inputs/$pr"
base="origin/$base_ref"
fork=$(git merge-base "$base" "$head")

tmp=${TMPDIR:-/tmp}
out=$(mktemp -d "${tmp%/}/simlock-review-$pr.XXXXXX")
mkdir "$out/spec" "$out/rules"

git diff "$fork" "$head" >"$out/diff.patch"

for f in $(git ls-tree --name-only "$base" docs/internal/agent-rules/); do
  git show "$base:$f" >"$out/rules/$(basename "$f")"
done
git show "$base:docs/internal/adr/README.md" >"$out/rules/adr-index.md"

# The issue: the second segment of a <kind>/<n> branch, else the first issue the body closes.
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
  gh issue view "$issue" --json body -q .body | tr -d '\r' >"$out/issue.md"
  labels=$(gh issue view "$issue" --json labels -q '.labels[].name')

  parent=$(gh api graphql -F owner="${nwo%/*}" -F repo="${nwo#*/}" -F number="$issue" -f query='
    query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){ issue(number:$number){ parent{ number } } } }' \
    -q '.data.repository.issue.parent.number // empty' 2>/dev/null || true)
  if [ -z "$parent" ]; then
    parent=$(grep -m 1 -oE '^Part of #[0-9]+' "$out/issue.md" | grep -oE '[0-9]+' || true)
  fi
  if [ -n "$parent" ]; then
    gh issue view "$parent" --json body -q .body | tr -d '\r' >"$out/feature.md"
  fi

  if printf '%s\n' "$labels" | grep -q '^bug:'; then
    gh issue view "$issue" --json comments \
      -q '[.comments[] | select(.body | test("(^|\n)## Simplest fix"))] | last | .body // empty' \
      | tr -d '\r' >"$out/triage.md"
    if [ ! -s "$out/triage.md" ]; then
      rm -f "$out/triage.md"
      say "bug #$issue has no triage report (no comment with a '## Simplest fix' section)"
    fi
  fi

  # ADRs by number, wherever the spec names them: "ADR 0014", "ADR-0014", "ADRs 0004 and 0005",
  # or a link to adr/0014-....md.
  adrs=$(cat "$out/issue.md" "$out/feature.md" "$out/triage.md" 2>/dev/null \
    | grep -oE 'ADRs?[ -]?[0-9]{4}((,? and |, | & |/)[0-9]{4})*|adr/[0-9]{4}-' \
    | grep -oE '[0-9]{4}' | sort -u || true)
  for n in $adrs; do
    path=$(git ls-tree --name-only "$base" docs/internal/adr/ | grep "/$n-" | head -n 1 || true)
    if [ -n "$path" ]; then
      git show "$base:$path" >"$out/spec/$(basename "$path")"
      continue
    fi
    path=$(git ls-tree --name-only "$head" docs/internal/adr/ | grep "/$n-" | head -n 1 || true)
    if [ -n "$path" ]; then
      git show "$head:$path" >"$out/spec/$(basename "$path")"
    else
      say "ADR $n is named by the spec but is on neither $base nor the PR head"
    fi
  done

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
  say "PR #$pr closes no issue (branch $head_ref, no 'Closes #n' in the body): no spec to review"
fi

# The final diff hides a red test that was deleted or loosened on the way to green.
red=$(git log --reverse --format='%H %s' "$base..$head" | awk '$2 == "test:" { print $1; exit }')
if [ -n "$red" ]; then
  set -f
  git diff "$red" "$head" -- $(git diff-tree --no-commit-id --name-only -r "$red") \
    >"$out/tests-after-red.patch"
  set +f
else
  say "no 'test:' commit on $head_ref: no tests-after-red.patch"
fi

say "#$pr at $(git rev-parse --short "$head"): issue ${issue:-none}, parent ${parent:-none}," \
  "ADRs $(ls "$out/spec" | grep -c '^[0-9]'), rules in play:${rules:- none}," \
  "assumptions $assumed, red commit $(if [ -n "$red" ]; then git rev-parse --short "$red"; else echo none; fi)"
echo "$out"
