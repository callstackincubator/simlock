# Instructions

Does: the rules for using Simlock as one static Markdown text, for agents and operators; and
`simlock setup`, which installs a small router skill that points an agent at them.

## Rules

The text:

- It is static: it never reads the catalog, the config or a daemon, and it names no path in this repository (only the website URL).
- `MCP_SERVER_INSTRUCTIONS` is built from the same section strings as `AGENT_INSTRUCTIONS`. Nothing is written twice.
- `MCP_SERVER_INSTRUCTIONS` stays at most 4096 characters, so a client that cuts long server instructions still gets all of it. No test holds this.
- A change to a refusal, an exit code or an agent-device message the text states fails `index.test.ts`, which reads them from their definitions.
- A command that ships changes its section.

Setup:

- `setup.ts` holds the tool table, the one place that knows the tools.
- `setupAgentTools` inspects every selected tool, and refuses a non-directory at `<skills>/simlock`, before any write (architecture rule 12). Then it writes the skills, then runs `mcp add` per written tool, one at a time.
- Writing the skill leaves nothing else in the `simlock` directory.
- It reads no home or working directory itself: the CLI passes both.
- `skill.ts` is the router skill, which holds no rule, so it stays right after an upgrade.
