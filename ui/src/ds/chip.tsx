import "./chip.css";

export type AgentKind = "claude-code" | "codex" | "cursor" | "pi" | "unknown";

// why: two letters, not a logo: a mark drawn from the tool's own name stays readable at 26px and
// needs no asset, and the dot says only "a holder no tool is known for", which is what the id holds.
const MARKS: Record<AgentKind, string> = {
  "claude-code": "CC",
  codex: "CX",
  cursor: "CU",
  pi: "PI",
  unknown: "",
};

export function AgentChip(props: {
  readonly kind: AgentKind;
  readonly title?: string | undefined;
}) {
  const { kind, title } = props;
  const mark = MARKS[kind];
  return (
    <span className={`chip-agent chip-agent-${kind}`} title={title}>
      {mark === "" ? <span className="chip-dot" /> : <span className="chip-mark">{mark}</span>}
    </span>
  );
}
