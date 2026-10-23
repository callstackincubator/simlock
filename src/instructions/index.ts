export const AGENT_INSTRUCTIONS = "";

export function renderInstructions(format: "text" | "json"): string {
  return format === "json" ? "" : AGENT_INSTRUCTIONS;
}
