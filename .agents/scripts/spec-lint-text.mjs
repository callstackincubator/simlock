import { prose, tables } from "./spec-body.mjs";
import { PATH_LINE, PLAIN_PATH_LINE, STOP } from "./spec-lint-patterns.mjs";

export function text(s) {
  return s === undefined ? "" : prose(s.lines).join("\n").trim();
}

export function squash(s) {
  return s.replace(/\s+/g, " ").trim();
}

export function lacksMermaid(s) {
  return s !== undefined && !s.lines.some((l) => /^\s*```mermaid\s*$/.test(l));
}

function ref(path, from, to, tool = false) {
  return { tool, path, from: +from, to: +(to ?? from) };
}

function backtickedRef(content, last) {
  const full = PATH_LINE.exec(content);
  if (full !== null) {
    const tool = full[1] !== undefined;
    return { found: ref(full[2], full[3], full[4], tool), last: tool ? null : full[2] };
  }
  const tail = /^:(\d+)(?:-(\d+))?$/.exec(content);
  if (tail === null || last === null) return { found: null, last };
  return { found: ref(last, tail[1], tail[2]), last };
}

function backtickedRefs(line) {
  const refs = [];
  let last = null;
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const next = backtickedRef(m[1], last);
    last = next.last;
    if (next.found !== null) refs.push(next.found);
  }
  return refs;
}

function plainRefs(line) {
  return [...line.replace(/`[^`]*`/g, " ").matchAll(PLAIN_PATH_LINE)].map((m) =>
    ref(m[1], m[2], m[3]),
  );
}

export function pathRefs(lines) {
  return prose(lines).flatMap((line) => [...backtickedRefs(line), ...plainRefs(line)]);
}

export function namedPaths(lines) {
  return new Set(
    [
      ...prose(lines)
        .join("\n")
        .matchAll(/`([\w@./-]+\/[\w@.-]+)(?::[\d-]+)?`/g),
    ].map((m) => m[1]),
  );
}

export function taskNumbers(cell) {
  return [...(cell ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

// why: Existing code says `none` under its Commit and Searches lines, so the word is looked for
// on a line of its own, never inside a sentence.
export function isNone(s) {
  const lines = prose(s.lines).map((l) => l.replaceAll("`", "").trim());
  return (
    !tables(s.lines).some((t) => t.header[0] === "Id") && lines.some((l) => /^none\.?$/i.test(l))
  );
}

export function bare(cell) {
  return cell.replaceAll("`", "").trim();
}

export function words(s) {
  return new Set(
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

function shared(a, b) {
  return [...a].filter((w) => b.has(w)).length;
}

// why: a line may spell out the cases its row only names ("object rows of Examples"), so it
// passes when it holds most of the row's Behaviour words, or most of the shorter of the two.
export function overlap(line, row) {
  const byBehaviour =
    row.behaviour.size === 0 ? 0 : shared(row.behaviour, line) / row.behaviour.size;
  const shorter = Math.min(line.size, row.words.size);
  return Math.max(byBehaviour, shorter === 0 ? 0 : shared(line, row.words) / shorter);
}
