export type AgentKind = "claude-code" | "codex" | "cursor" | "pi" | "unknown";

// why: the tail of a holder id is what tells two sessions of one tool apart, so a long id keeps its
// head, which names the tool, and its last six units.
const MAX_HOLDER_UNITS = 34;
const HOLDER_HEAD_UNITS = 25;
const HOLDER_TAIL_UNITS = 6;

// why: the operator may ask for whole ids (Settings). The pages build their rows from the style in
// force when they mount, and the setting is changed on a page that shows no holder.
let wholeIds = false;

export function setHolderStyle(style: "short" | "full"): void {
  wholeIds = style === "full";
}

export function shortHolder(id: string): string {
  if (wholeIds || id.length <= MAX_HOLDER_UNITS) return id;
  return `${id.slice(0, HOLDER_HEAD_UNITS)}\u2026${id.slice(-HOLDER_TAIL_UNITS)}`;
}

// why: a tool is named only by the exact prefix its own session id carries, so a label the holder
// chose for itself, however tool-like, never gets a chip.
const TOOL_PREFIXES: readonly [AgentKind, string][] = [
  ["claude-code", "claude-code:"],
  ["codex", "codex:"],
  ["cursor", "cursor:"],
  ["pi", "pi:"],
];

export function agentKind(id: string): AgentKind {
  for (const [kind, prefix] of TOOL_PREFIXES) {
    if (id.startsWith(prefix)) return kind;
  }
  return "unknown";
}
