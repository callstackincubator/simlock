export type AgentKind = "claude-code" | "codex" | "cursor" | "pi" | "unknown";

export function shortHolder(_id: string): string {
  return "";
}

export function agentKind(_id: string): AgentKind {
  return "unknown";
}
