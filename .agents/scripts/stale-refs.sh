#!/usr/bin/env sh
# Lists the lines that still name something a branch removed, anywhere in the repo, not only in
# the diff: a deleted or moved path, a declaration that no longer exists, a quoted string no code
# file contains any more. Each hit is a claim to check; the script judges nothing. Uses only git.
#
#   .agents/scripts/stale-refs.sh [<base>] [<head>]      defaults: origin/main, HEAD
#
# Prints nothing when there is no hit. ADRs and CHANGELOG.md are history and are not searched;
# STALE_REFS_EXCLUDE (git pathspecs, space-separated) replaces that list. STALE_REFS_MAX caps the
# hits printed per name (default 20).
set -euf
export LC_ALL=C

base=${1:-origin/main}
head=${2:-HEAD}
max=${STALE_REFS_MAX:-20}
exclude=${STALE_REFS_EXCLUDE:-":(exclude)docs/internal/adr/ :(exclude)CHANGELOG.md"}
fork=$(git merge-base "$base" "$head")
keywords='class|interface|type|enum|struct|trait|protocol|function|func|fn|def|const|let|var|val'
tmp=$(mktemp -d "${TMPDIR:-/tmp}/stale-refs.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# search <pathspec> <git grep options...>: git grep over the head tree, without the "<head>:"
# prefix on each line.
search() {
  spec=$1
  shift
  # shellcheck disable=SC2086 # $spec and $exclude are lists of pathspecs
  git grep -I "$@" "$head" -- $spec $exclude 2>/dev/null | sed "s#^$head:##" || true
}

# group <terms file> <lines file> <word|any> <kind> <note>: for each term, the lines that contain
# it (as a whole word with "word"), under a header "<kind> <term> <note>", at most $max per term.
group() {
  awk -v max="$max" -v word="$3" -v kind="$4" -v note="$5" '
    FNR == NR { terms[++n] = $0; next }
    { lines[++m] = $0 }
    END {
      for (i = 1; i <= n; i++) {
        t = terms[i]; c = 0
        for (j = 1; j <= m; j++) {
          l = lines[j]; p = index(l, t)
          if (p == 0) continue
          if (word == "word") {
            before = substr(l, p - 1, 1); after = substr(l, p + length(t), 1)
            if (before ~ /[A-Za-z0-9_]/ || after ~ /[A-Za-z0-9_]/) continue
          }
          if (++c == 1) printf "%s %s %s\n", kind, t, note
          if (c <= max) printf "  %s\n", substr(l, 1, 200)
        }
        if (c > max) printf "  ... %d more\n", c - max
      }
    }' "$1" "$2"
}

git diff "$fork" "$head" | grep '^-' | grep -v '^---' >"$tmp/removed" || true
git diff "$fork" "$head" | grep '^+' | grep -v '^+++' >"$tmp/added" || true
git diff "$fork" "$head" -- . ':(exclude)*.md' | grep '^-' | grep -v '^---' >"$tmp/removed-code" || true

# Deleted or moved paths. A mention may drop the root directory and the extension
# ("core/wait-queue" for src/core/wait-queue.ts), so the search is the last two segments without
# the extension, or the file name without it when the path has one segment.
git diff --name-status -M "$fork" "$head" | awk '$1 ~ /^[DR]/ { print $1, $2, $3 }' |
  while read -r status old new; do
    git cat-file -e "$head:$old" 2>/dev/null && continue
    printf '%s\n' "$old" |
      awk -F/ '{ t = (NF > 1 ? $(NF-1) "/" $NF : $NF); sub(/\.[^.\/]*$/, "", t); print t }' \
        >"$tmp/path-term"
    search . -n -F -f "$tmp/path-term" >"$tmp/path-hits"
    [ -s "$tmp/path-hits" ] || continue
    case $status in
      R*) note="($old, moved to $new)" ;;
      *) note="($old, deleted)" ;;
    esac
    group "$tmp/path-term" "$tmp/path-hits" any path "$note"
  done

# Names declared on a removed line and declared nowhere at the head. Only names that read as
# code (PascalCase, camelCase, snake_case): a plain word like "timers" is everywhere.
grep -oE "(^|[^A-Za-z0-9_])($keywords)[[:space:]]+[A-Za-z_][A-Za-z0-9_]{3,}" "$tmp/removed" |
  awk '{ print $NF }' | grep -E '^[A-Z]|[a-z][A-Z]|_' | sort -u >"$tmp/names" || true
search . -h -o -E "(^|[^A-Za-z0-9_])($keywords)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*" |
  awk '{ print $NF }' | sort -u >"$tmp/declared"
comm -23 "$tmp/names" "$tmp/declared" >"$tmp/gone"
if [ -s "$tmp/gone" ]; then
  search . -n -w -F -f "$tmp/gone" >"$tmp/name-hits"
  group "$tmp/gone" "$tmp/name-hits" word name "(declaration removed)"
fi

# Quoted names (an event, a config key, an error code, a path) on a removed line of a code file
# that no added line and no code file at the head contains, but a Markdown file still does.
grep -oE "[\"'\`][A-Za-z0-9_.:/-]{4,}[\"'\`]" "$tmp/removed-code" | sed "s/^.//; s/.\$//" |
  grep -E '[._:/-]' | sort -u >"$tmp/strings" || true
if [ -s "$tmp/strings" ]; then
  {
    grep -o -F -f "$tmp/strings" "$tmp/added" || true
    search ". :(exclude)*.md" -h -o -F -f "$tmp/strings"
  } | sort -u >"$tmp/still-used"
  comm -23 "$tmp/strings" "$tmp/still-used" >"$tmp/dropped"
  if [ -s "$tmp/dropped" ]; then
    search "*.md" -n -F -f "$tmp/dropped" >"$tmp/string-hits"
    group "$tmp/dropped" "$tmp/string-hits" any string "(no code file has it)"
  fi
fi
