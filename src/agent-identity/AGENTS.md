# Agent identity

Does: the default requester id a frontend sends when the caller names none.

## Rules

- Imports nothing: it is the one component the CLI's router imports statically (dependency rule `cli-router-imports-no-component-values`).
- The CLI and the MCP server both resolve through `resolveRequesterId`, so under a session variable they are one requester. Their fallbacks differ, so without one they are two.
