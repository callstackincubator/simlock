# Instructions

Does: the rules for using Simlock as one static Markdown text, for agents and operators.
Entry: `index.ts` → `AGENT_INSTRUCTIONS`, `MCP_SERVER_INSTRUCTIONS`, `renderInstructions(format)`.
Uses: nothing. Called by: CLI (`simlock instructions`, `cli/commands/instructions.ts` only), MCP
(`mcp/server.ts`: the server instructions and the resource `simlock://instructions`).

`AGENT_INSTRUCTIONS` is a title, an intro, five `##` sections (rules for every agent, agent-device,
iOS builds, the `simlock` CLI, MCP) and the website link. `MCP_SERVER_INSTRUCTIONS` is built from the
same section strings: the title, the rules section, the MCP section and a pointer to
`simlock instructions`. It stays at most 4096 characters, so a client that cuts long server
instructions still gets all of it. Nothing is written twice.

The text is static: it never reads the catalog, the config or a daemon, and it names no path in this
repository (only the website URL). A change to a refusal, an exit code or an agent-device message the
text states fails `index.test.ts`, which reads them from their definitions. A command that ships
changes its section.
