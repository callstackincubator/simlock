export const AGENT_INSTRUCTIONS = `# Using Simlock to share iOS simulators and Android emulators
`;

export function renderInstructions(format: "text" | "json"): string {
  return format === "json"
    ? JSON.stringify({ instructions: AGENT_INSTRUCTIONS })
    : AGENT_INSTRUCTIONS;
}
