# Agent guide

Simlock leases iOS simulators and Android emulators to parallel coding
agents.

## Binding

- [docs/internal/agent-rules/](docs/internal/agent-rules/): every file binds
  every change. Start with [always-in-scope.md](docs/internal/agent-rules/always-in-scope.md);
  take every command from [toolchain.md](docs/internal/agent-rules/toolchain.md).
- [docs/internal/adr/](docs/internal/adr/): accepted ADRs bind. One marked
  _Accepted — not yet implemented_ is the target: build toward it, and never
  "fix" docs that describe it (ADRs 0004, 0005) back to today's code.
- Module manuals: before reading, changing or reviewing a file under `src/`,
  load the `AGENTS.md` of every module directory on its path. A change that
  makes a manual false fixes it.

## Where to look

| Need                              | Read                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Architecture, modules, boundaries | [ARCHITECTURE.md](docs/internal/ARCHITECTURE.md)                                 |
| Paths across modules              | [flows/](docs/internal/flows/)                                                   |
| Exploring before a change         | [EXPLORATION.md](docs/internal/EXPLORATION.md)                                   |
| Issues, specs, delivery           | [DELIVERY.md](docs/internal/DELIVERY.md), [templates/](docs/internal/templates/) |
| Review protocol                   | [REVIEW.md](docs/internal/REVIEW.md)                                             |
| Business events                   | [EVENTS.md](docs/internal/EVENTS.md) (with rationale)                            |
| Console and landing design        | [DESIGN.md](docs/internal/DESIGN.md)                                             |
| Third-party code                  | [VENDORED-CODE.md](docs/internal/VENDORED-CODE.md)                               |
| Post-v1 ideas (not unless asked)  | [IDEAS.md](docs/internal/IDEAS.md)                                               |
| Skills and agents                 | `.claude/skills/`, `.claude/agents/`, briefs in `.agents/briefs/`                |

## Docs

Which doc goes where: [documentation.md](docs/internal/agent-rules/documentation.md).

End-user docs live directly under [docs/](docs/), self-contained (no links
into `docs/internal/`):
[ABOUT.md](docs/ABOUT.md),
[CLI.md](docs/CLI.md),
[CLIENT.md](docs/CLIENT.md),
[CONFIGURATION.md](docs/CONFIGURATION.md),
[HTTP-API.md](docs/HTTP-API.md),
[CONSOLE.md](docs/CONSOLE.md),
[EVENTS.md](docs/EVENTS.md).

Maintainer/agent docs live under [docs/internal/](docs/internal/) (table above).
