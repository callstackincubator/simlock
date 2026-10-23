# Instructions

Does: the rules for using Simlock as one static Markdown text, for agents and operators; and
`simlock setup`, which installs a small router skill that points an agent at them.
Entry: `index.ts` → `AGENT_INSTRUCTIONS`, `MCP_SERVER_INSTRUCTIONS`, `renderInstructions(format)`,
`renderSkill()`, `setupAgentTools(options)`, `toolRunner(processRunner)`.
Uses: ports (`Filesystem`, `ProcessRunner`, for `setup` only). Called by: CLI (`simlock instructions`
and `simlock setup`, `cli/commands/instructions.ts` and `cli/commands/setup.ts` only), MCP
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

## Setup

`setup.ts` holds the tool table, the one place that knows the tools: `claude-code` (presence
`.claude`, skills `.claude/skills`) and `codex` (presence `.codex`, or `$CODEX_HOME` at the user
scope; skills `.agents/skills`), under the scope's base: the home directory or the working
directory. `setupAgentTools` runs in this order: the scope (flag, else a prompt in a terminal, else
user); inspect every selected tool, refusing a non-directory at `<skills>/simlock` before any write
(architecture rule 12); the MCP prompt per tool to be written; write the skill file and leave nothing else
in the `simlock` directory; then `mcp add` per written tool, one at a time, through `runTool` (30 s
each). It reads no home or working directory itself: the CLI passes both. `skill.ts` is the router
skill, which holds no rule, so it stays right after an upgrade.
