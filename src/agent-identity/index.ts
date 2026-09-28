/**
 * The default requester id a frontend declares when the caller names none. Both the CLI and
 * `simlock mcp` call this one function, so the two cannot drift apart (architecture rule 10).
 * Resolution happens in the frontend; the daemon only sees the id it is sent.
 *
 * Order, first match wins:
 *
 * 1. `SIMLOCK_AGENT_ID`, when defined -- unchanged from before session detection existed.
 * 2. The first row of `AGENT_SESSION_VARIABLES` whose variable is set and not empty, as
 *    `<tool>:<value>`. Every command and sub-agent in one agent session shares that session's
 *    id, and so its one lease.
 * 3. `fallback`, the frontend's own pid-derived value.
 *
 * The session value gets no more checking than `SIMLOCK_AGENT_ID` does: it is passed through
 * as-is, and only the empty string is skipped.
 */

/** The agent tools whose session id Simlock reads, in the order they are tried. Adding a tool
 * is one row here and one test. */
// fallow-ignore-next-line unused-export -- the spec'd public table; exported so the supported tools are readable in one place.
export const AGENT_SESSION_VARIABLES: readonly {
  readonly tool: string;
  readonly variable: string;
}[] = [
  { tool: "claude-code", variable: "CLAUDE_CODE_SESSION_ID" },
  { tool: "codex", variable: "CODEX_SESSION_ID" },
];

export function resolveRequesterId(env: NodeJS.ProcessEnv, fallback: string): string {
  if (env.SIMLOCK_AGENT_ID !== undefined) return env.SIMLOCK_AGENT_ID;
  for (const { tool, variable } of AGENT_SESSION_VARIABLES) {
    const sessionId = env[variable];
    if (sessionId !== undefined && sessionId !== "") return `${tool}:${sessionId}`;
  }
  return fallback;
}
