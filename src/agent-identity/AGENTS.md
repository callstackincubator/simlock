# Agent identity

Does: the default requester id a frontend sends when the caller names none.
Entry: `index.ts` → `resolveRequesterId(env, fallback)`, `AGENT_SESSION_VARIABLES`.
Uses: nothing. Called by: CLI (fallback: the pid), MCP (fallback: `mcp:<pid>`).

Order, first wins: `SIMLOCK_AGENT_ID` → `claude-code:<CLAUDE_CODE_SESSION_ID>` →
`codex:<CODEX_SESSION_ID>` → `fallback`. An empty session variable is skipped.
Adding an agent tool: one row in `AGENT_SESSION_VARIABLES`, one test.
