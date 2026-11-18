// The PR body's `## Review` section (delivery rule 14), built from the findings file so nobody
// counts by hand: over 60 merged PRs the hand-written counts followed four different rules.
// review-ledger.mjs writes it; pr-body-check.mjs and delivery-stats.mjs parse it.
//
//   Spec review: <b> blocking, <m> fixed, <k> notes. Code review: ... Claims review: ...
//   Rounds: <n>. Tokens: <t>M.
//   <runs: the first line review-metrics.mjs prints>
//
//   Rejected:
//
//   <the rejected lines, as given>
//
//   Assessment: complete | incomplete — <why>
//
// <b> is the role's findings whose outcome is neither `duplicate` nor `nonblocking`, <m> those
// `fixed`, <k> the lines of `notes` that start `- <role>:`; a role under `skipped` prints
// `skipped.` in place of its counts. <n> counts the rounds named 1 or 2. The assessment is
// incomplete when `incomplete` gives a reason or a finding is `open`.
const ROLES = [
  ["spec", "Spec"],
  ["code", "Code"],
  ["claims", "Claims"],
];
const REJECTED = /^- (?:spec|code|claims): .*\[(?:incorrect|intentional|nonblocking)\]/;

export function reviewSection(input) {
  const { findings, rounds, skipped = [], notes = "", rejected = "", incomplete = null } = input;
  const counts = ROLES.map(([role, name]) => {
    if (skipped.includes(role)) return `${name} review: skipped.`;
    const own = findings.filter(
      (f) => f.role === role && f.outcome !== "duplicate" && f.outcome !== "nonblocking",
    );
    const fixed = own.filter((f) => f.outcome === "fixed").length;
    const noted = notes.split("\n").filter((l) => l.startsWith(`- ${role}:`)).length;
    return `${name} review: ${own.length} blocking, ${fixed} fixed, ${noted} notes.`;
  });
  const rejections = rejected.split("\n").filter((l) => l.trim() !== "");
  const bad = rejections.find((l) => !REJECTED.test(l));
  if (bad !== undefined) {
    throw new Error(
      `a rejected line is \`- spec|code|claims: <claim> [incorrect|intentional|nonblocking] — <reason>\`: ${bad}`,
    );
  }
  const open = findings.filter((f) => f.outcome === "open").map((f) => f.id);
  const why = incomplete ?? (open.length > 0 ? `${open.join(", ")} open` : null);
  const full = rounds.filter((r) => r === "1" || r === "2").length;
  const tokens = input.tokens === undefined ? "n/a" : `${input.tokens}M`;
  return [
    [counts.join(" "), `Rounds: ${full}. Tokens: ${tokens}.`, input.runs ?? ""]
      .filter((l) => l !== "")
      .join("\n"),
    ...(rejections.length > 0 ? ["Rejected:", rejections.join("\n")] : []),
    why === null ? "Assessment: complete" : `Assessment: incomplete — ${why}`,
  ].join("\n\n");
}
