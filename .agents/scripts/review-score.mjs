#!/usr/bin/env node
// `node .agents/scripts/review-score.mjs --pr <M> --round <r> --findings <file.json|report.txt> [--role <lens>] [--variant <label>] [--since <iso>]`:
// scores a replayed review (review-replay.sh) against the snapshot's ground truth
// (refs/replay/<M>/truth on origin, from replay-freeze.mjs; the snapshot file holds only SHAs).
//
// A ground-truth finding is a defect when its outcome is `fixed` or `open`; the others
// (`nonblocking`, `intentional`, `incorrect`, `duplicate`) are known non-defects. A replay finding
// matches a ground-truth one when both name the same file (the path before any `:line`) and
// share a class word, or when the file has exactly one ground-truth finding of that role. Recall
// is matched defects over defects; a replay finding matching nothing is `unmatched` and needs a
// person's adjudication (new true finding, or false positive). Cost and seconds come from the
// stage=replay runs review-metrics.mjs --replay reports, from --since on (the `started:` line
// review-replay.sh printed), so replays of one snapshot stay apart. One row goes to
// .agents/replay/results.jsonl.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const pr = option("--pr");
const round = option("--round");
const file = option("--findings");
const variant = option("--variant") ?? "current";
const since = option("--since");
if (!/^\d+$/.test(pr ?? "") || !round || !file) {
  console.error(
    "usage: review-score.mjs --pr <M> --round <r> --findings <file.json> [--variant <label>] [--since <iso>]",
  );
  process.exit(64);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const snapshot = JSON.parse(readFileSync(join(root, ".agents/replay", `${pr}.json`), "utf8"));
// why: a lens report (review-replay.sh --lens) is text, `F1 B path:line claim [class] ev: ...`,
// B blocking and N a note, while the coordinator's findings file is JSON; --role names the lens.
const role = option("--role");
const replay = file.endsWith(".json")
  ? (JSON.parse(readFileSync(file, "utf8")).findings ?? [])
  : [
      ...readFileSync(file, "utf8").matchAll(
        /^(F\d+)\s+([BN])\s+(\S+)\s+(.*?)(?:\s+\[([^\]]+)\])?(?:\s+ev:.*)?$/gm,
      ),
    ].map((m) => ({
      id: m[1],
      role: role ?? "lens",
      outcome: m[2] === "B" ? "open" : "nonblocking",
      path: m[3],
      class: m[5] ?? m[4].slice(0, 60),
    }));
// why: the ground truth lives on origin as a blob, never in the checkout, so a replaying
// reviewer cannot stumble on the answers (the first one did).
execFileSync("git", ["fetch", "-q", "origin", `+refs/replay/${pr}/truth:refs/replay/${pr}/truth`], {
  cwd: root,
});
const truthFindings = JSON.parse(
  execFileSync("git", ["cat-file", "-p", `refs/replay/${pr}/truth`], {
    cwd: root,
    encoding: "utf8",
  }),
).findings;

// why: a finding may name several places, "a.ts:12 (and b.ts:40, c.ts:7)", and each counts.
const filesOf = (p) => [...String(p ?? "").matchAll(/[\w@./-]+\.[a-z]+/g)].map((m) => m[0]);
const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "by",
  "to",
  "is",
  "not",
  "and",
  "or",
  "for",
  "with",
  "rule",
  "testing",
  "safety",
  "architecture",
  "documentation",
  "coding",
  "events",
]);
const words = (c) =>
  new Set(
    String(c ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
  );
const ruleRefs = (c) =>
  new Set(
    [
      ...String(c ?? "").matchAll(
        /\b(testing|safety|architecture|documentation|coding|events)\s+(\d+)/gi,
      ),
    ].map((m) => `${m[1].toLowerCase()} ${m[2]}`),
  );
const overlap = (a, b) => {
  const wa = words(a),
    wb = words(b);
  if ([...wa].some((w) => wb.has(w))) return true;
  const ra = ruleRefs(a),
    rb = ruleRefs(b);
  return [...ra].some((r) => rb.has(r));
};

const truth = truthFindings.map((f) => ({
  ...f,
  files: filesOf(f.path),
  defect: f.outcome === "fixed" || f.outcome === "open",
}));
const taken = new Set();
const matches = [];
const unmatched = [];
for (const r of replay) {
  const rf = filesOf(r.path);
  const base = (f) => f.split("/").pop();
  let same = truth.filter((t) => t.files.some((f) => rf.includes(f)) && !taken.has(t.id));
  // why: a lens often names a file by its basename alone ("main.ts:1177"); that counts when
  // exactly one ground-truth file has that basename.
  if (same.length === 0) {
    const names = new Set(rf.map(base));
    const byName = truth.filter((t) => !taken.has(t.id) && t.files.some((f) => names.has(base(f))));
    const distinct = new Set(byName.flatMap((t) => t.files.filter((f) => names.has(base(f)))));
    if (distinct.size === 1) same = byName;
  }
  let hit = same.find((t) => overlap(t.class, r.class));
  if (!hit && same.length === 1 && same[0].role === r.role) hit = same[0];
  if (hit) {
    taken.add(hit.id);
    matches.push({ replay: r.id, truth: hit.id, truthOutcome: hit.outcome });
  } else unmatched.push(r);
}
// why: a single lens is judged on the findings its role owned in the real review.
const defects = truth.filter((t) => t.defect && (role === null || t.role === role));
const found = defects.filter((t) => taken.has(t.id));
const missed = defects.filter((t) => !taken.has(t.id));
const nonDefectHits = matches.filter((m) => !["fixed", "open"].includes(m.truthOutcome));

let runs = { runs: 0, seconds: null, costUsd: null };
try {
  const metrics = (...extra) =>
    JSON.parse(
      execFileSync(
        "node",
        [
          join(root, ".agents/scripts/review-metrics.mjs"),
          "--pr",
          pr,
          ...(snapshot.issue ? ["--issue", String(snapshot.issue)] : []),
          "--json",
          ...extra,
        ],
        { encoding: "utf8" },
      ),
    ).runs;
  // why: a coordinator sometimes writes stage=review into its lens prompts instead of
  // stage=replay. The PR is merged, so no live review runs after the freeze: with --since,
  // a review run started after it is this replay's.
  const all = [
    ...metrics("--replay"),
    ...(since === null ? [] : metrics().filter((r) => r.stage === "review")),
  ];
  const mine = all.filter(
    (r) =>
      r.round === round && (since === null || Date.parse(r.startedAt ?? "") >= Date.parse(since)),
  );
  const sum = (k) =>
    mine.some((r) => r[k] === null) ? null : mine.reduce((a, r) => a + (r[k] ?? 0), 0);
  runs = { runs: mine.length, seconds: sum("seconds"), costUsd: sum("costUsd") };
} catch {}

const show = (v) => (v === null || v === undefined ? "unknown" : v);
// why: a coordinator that spawns no lens is a self-check, not the review under test; its
// findings say nothing about the reviewer and the row must not be read as a result.
const selfCheck = role === null && runs.runs < 2;
if (selfCheck)
  console.log(
    `INVALID: ${runs.runs} tagged run(s) for round ${round}, so no lens agent ran; this is a self-check, not the review.`,
  );
const baseline = snapshot.rounds?.[round]?.baseline;
console.log(
  `PR #${pr} round ${round}, variant ${variant}: recall ${found.length}/${defects.length} defects; ${unmatched.length} unmatched replay findings; ${nonDefectHits.length} hits on known non-defects.`,
);
console.log(
  `Replay runs ${runs.runs}, seconds ${show(runs.seconds)}, USD ${show(runs.costUsd)}; real review: runs ${show(baseline?.runs)}, seconds ${show(baseline?.seconds)}, USD ${show(baseline?.costUsd)}.`,
);
for (const m of matches) console.log(`  match ${m.replay} -> ${m.truth} (${m.truthOutcome})`);
for (const t of missed) console.log(`  MISSED ${t.id} ${t.role} [${t.class}] ${t.path}`);
for (const r of unmatched)
  console.log(`  unmatched ${r.id} ${r.role} [${r.class}] ${r.path} (adjudicate)`);
appendFileSync(
  join(root, ".agents/replay/results.jsonl"),
  JSON.stringify({
    at: new Date().toISOString(),
    pr: Number(pr),
    round,
    variant,
    valid: !selfCheck,
    agentsCommit: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    recall: `${found.length}/${defects.length}`,
    found: found.map((t) => t.id),
    missed: missed.map((t) => t.id),
    unmatched: unmatched.map((r) => `${r.id} ${r.path} [${r.class}]`),
    nonDefectHits: nonDefectHits.length,
    replay: runs,
    baseline: baseline ?? null,
  }) + "\n",
);
