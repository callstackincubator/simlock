// `bodyDefects(text)`: what delivery rules 2, 8 and 12 say about a body or comment an agent
// posts, for the tool guard to refuse before it is posted. One sentence per defect, naming the
// rule; an empty list when the body passes. Words are counted outside code blocks, without
// headings and the footer line.
//
//   every body          the last line is `*Written by an agent.*` (rule 12)
//   `## Handoff`        Done, Not done, Findings, Blocked on, once each and in that order (rule
//                       2); at most 150 words
//   `## Reproduction`   (a triage report, maybe after `Supersedes the report above.`) the
//                       headings Reproduction, Root cause, Simplest fix, Alternatives rejected,
//                       Risk and an optional Side findings, in order (rule 8); a `path:line` in
//                       Root cause; at most three Alternatives lines and three Risk bullets; at
//                       most 300 words
//   `Spec updated:`     one line and the footer
//   `## Review notes`   every note one bullet on one line
const FOOTER = /^[*_]Written by an agent\.[*_]$/;
const HANDOFF = ["Done", "Not done", "Findings", "Blocked on"];
const TRIAGE = ["Reproduction", "Root cause", "Simplest fix", "Alternatives rejected", "Risk"];

// why: the first lines name what a body is; the first kind whose `at` holds checks it.
const KINDS = [
  { at: (filled) => /^## Handoff\s*$/.test(filled[0] ?? ""), check: handoff },
  { at: isTriageReport, check: triage },
  { at: (filled) => (filled[0] ?? "").startsWith("Spec updated:"), check: specUpdated },
  { at: (filled) => /^## Review notes\s*$/.test(filled[0] ?? ""), check: reviewNotes },
];

export function bodyDefects(raw) {
  const text = String(raw ?? "").replace(/\r/g, "");
  const lines = withoutCode(text).split("\n");
  const filled = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const defects = [];
  if (!FOOTER.test(filled.at(-1) ?? "")) {
    defects.push(
      "Every body and comment an agent writes ends with the line `*Written by an agent.*` (delivery rule 12): add it as the last line.",
    );
  }
  const kind = KINDS.find((k) => k.at(filled));
  return kind === undefined ? defects : [...defects, ...kind.check(lines, filled)];
}

function isTriageReport(filled) {
  const [first = "", second = ""] = filled;
  const report = (l) => /^## Reproduction\s*$/.test(l);
  return report(first) || (/^Supersedes the report above\.?$/.test(first) && report(second));
}

function specUpdated(_, filled) {
  if (filled.filter((l) => !FOOTER.test(l)).length <= 1) return [];
  return [
    'A "Spec updated" comment is one line and the footer (delivery rule 12): say in that line which sections moved.',
  ];
}

function handoff(lines) {
  const found = [];
  for (const l of lines) {
    // why: a label is a heading, emphasised or followed by a colon; prose may start "Done when".
    const label =
      /^(?:- )?(#{2,6}\s+)?(\*\*|__|\*|_)?(Done|Not done|Findings|Blocked on)(?:\*\*|__|\*|_)?(:)?(?:\*\*|__)?(?=\s|$)/.exec(
        l.trim(),
      );
    if (label !== null && (label[1] || label[2] || label[4])) found.push(label[3]);
  }
  const out = [];
  if (found.join("|") !== HANDOFF.join("|")) {
    out.push(
      `A \`## Handoff\` has four parts, once each and in this order: Done, Not done, Findings, Blocked on (delivery rule 2); this one has ${found.length === 0 ? "none" : found.join(", ")}.`,
    );
  }
  const words = countWords(lines);
  if (words > 150) {
    out.push(
      `This handoff is ${words} words outside code; the budget is 150 (delivery rule 12): cut it.`,
    );
  }
  return out;
}

const TRIAGE_RULES = [
  {
    when: (lines) => {
      const headings = lines.flatMap((l) => /^##\s+(.+?)\s*$/.exec(l)?.slice(1) ?? []);
      const expected = headings.at(-1) === "Side findings" ? [...TRIAGE, "Side findings"] : TRIAGE;
      return headings.join("|") !== expected.join("|");
    },
    reason: () =>
      "A triage report has the sections Reproduction, Root cause, Simplest fix, Alternatives rejected, Risk and, when there are any, Side findings, in that order (delivery rule 8).",
  },
  {
    when: (lines) =>
      sectionHas(lines, "Root cause", (body) => !/\S+\.\w+:\d+/.test(body.join("\n"))),
    reason: () => "The Root cause names the file and line, as `path:line` (delivery rule 8).",
  },
  {
    when: (lines) =>
      sectionHas(
        lines,
        "Alternatives rejected",
        (body) => body.filter((l) => l.trim() !== "").length > 3,
      ),
    reason: () =>
      "Alternatives rejected holds at most three lines, one per alternative (delivery rule 8).",
  },
  {
    when: (lines) =>
      sectionHas(lines, "Risk", (body) => body.filter((l) => /^\s*[-*] /.test(l)).length > 3),
    reason: () => "Risk holds at most three bullets (delivery rule 8).",
  },
  {
    when: (lines) => countWords(lines) > 300,
    reason: (lines) =>
      `This report is ${countWords(lines)} words outside code; the budget is 300 (delivery rule 12): cut it.`,
  },
];

function triage(lines) {
  return TRIAGE_RULES.filter((r) => r.when(lines)).map((r) => r.reason(lines));
}

function sectionHas(lines, name, test) {
  const body = section(lines, name);
  return body !== null && test(body);
}

function reviewNotes(lines) {
  let inBullet = false;
  for (const l of lines) {
    if (l.trim() === "" || FOOTER.test(l.trim())) inBullet = false;
    else if (/^\s*[-*] /.test(l)) inBullet = true;
    else if (inBullet) {
      return [
        "In `## Review notes` each note is one bullet on one line (delivery rule 12): join or cut the line that continues a bullet.",
      ];
    }
  }
  return [];
}

function section(lines, name) {
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`).test(l));
  if (at === -1) return null;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  return lines.slice(at + 1, end === -1 ? lines.length : end);
}

function countWords(lines) {
  return lines
    .filter((l) => !/^#{1,6}\s/.test(l) && !FOOTER.test(l.trim()))
    .reduce((sum, l) => sum + l.split(/\s+/).filter((w) => /\w/.test(w)).length, 0);
}

function withoutCode(text) {
  let inside = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        inside = !inside;
        return "";
      }
      return inside ? "" : l;
    })
    .join("\n");
}
