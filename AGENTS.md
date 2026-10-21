# Agent guide

Simlock leases iOS simulators and Android emulators to parallel coding
agents.

## Who reads what

One hop: a role's files are listed here and in its agent file, and nothing
a role must obey on every run sits a link further away. The rules under
[docs/internal/agent-rules/](docs/internal/agent-rules/) bind every change;
they are the reference a finding cites, not a reading list.

| Role                            | Reads on every run                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator (`deliver`)        | its skill; [delivery.md](docs/internal/agent-rules/delivery.md) rules 1, 2, 3, 9, 14, 15, 16                               |
| Implementer (build, audit, fix) | `implementer.md` (its checklist is inline); the mode brief, pasted into its prompt; the manual of every module on its path |
| Reviewer (coordinator)          | `reviewer.md`; [REVIEW.md](docs/internal/REVIEW.md), pasted into its prompt                                                |
| Spec, code and claims lenses    | the brief and `calibration.md`, pasted into the prompt from the pinned inputs                                              |
| Spec writer (`spec-session`)    | its skill; [templates/](docs/internal/templates/); `spec-checker.md`                                                       |
| Everyone touching `src/`        | the `AGENTS.md` of every module directory on the path; a change that makes a manual false fixes it                         |

Commands come from [toolchain.md](docs/internal/agent-rules/toolchain.md).
Accepted ADRs under [docs/internal/adr/](docs/internal/adr/) bind; one
marked _Accepted — not yet implemented_ is the target: build toward it, and
never "fix" docs that describe it (ADRs 0004, 0005) back to today's code.

## Where to look

| Need                              | Read                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Architecture, modules, boundaries | [ARCHITECTURE.md](docs/internal/ARCHITECTURE.md)                                 |
| Paths across modules              | [flows/](docs/internal/flows/)                                                   |
| Exploring before a change         | [EXPLORATION.md](docs/internal/EXPLORATION.md)                                   |
| Issues, specs, delivery           | [DELIVERY.md](docs/internal/DELIVERY.md), [templates/](docs/internal/templates/) |
| Review protocol                   | [REVIEW.md](docs/internal/REVIEW.md)                                             |
| Business events                   | [EVENTS.md](docs/internal/EVENTS.md) (with rationale)                            |
| Console design                    | [DESIGN.md](docs/internal/DESIGN.md)                                             |
| Website and brand visuals         | [BRAND.md](docs/internal/BRAND.md)                                               |
| Third-party code                  | [VENDORED-CODE.md](docs/internal/VENDORED-CODE.md)                               |
| Post-v1 ideas (not unless asked)  | [IDEAS.md](docs/internal/IDEAS.md)                                               |
| Skills and agents                 | `.claude/skills/`, `.claude/agents/`, briefs in `.agents/briefs/`                |

## Docs

Which doc goes where: [documentation.md](docs/internal/agent-rules/documentation.md).

End-user docs live only on the website, in
[website/src/content/docs/](website/src/content/docs/) (sidebar in
`website/astro.config.mjs`). A change to the public surface (CLI, config,
HTTP API, MCP tools, client exports, events, console) updates the pages
that describe it in the same change (documentation rule 9).

Maintainer/agent docs live under [docs/internal/](docs/internal/) (table above).
