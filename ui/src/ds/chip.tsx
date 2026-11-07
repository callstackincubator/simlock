import "./chip.css";

export type AgentKind = "claude-code" | "codex" | "cursor" | "pi" | "unknown";

export function AgentChip(_props: {
  readonly kind: AgentKind;
  readonly title?: string | undefined;
}) {
  return null;
}
