# Agent guide

Simlock is a control plane for iOS simulators and Android emulators that lets
parallel coding agents lease devices without fighting over them.

## Rules — read before writing code

The rules in [docs/internal/agent-rules/](docs/internal/agent-rules/) are binding for all
changes in this repo:

- [architecture.md](docs/internal/agent-rules/architecture.md) — loosely coupled
  modules; platform-agnostic core; iOS and Android encapsulated in their own
  driver modules; event bus for observers only; one place enforces a rule;
  bounded cross-process waits; every exit leaves one named state.
- [events.md](docs/internal/agent-rules/events.md) — event naming
  (`subject.past-tense-fact`), post-commit emission, payload contracts,
  keeping EVENTS.md in sync.
- [safety.md](docs/internal/agent-rules/safety.md) — registry-only destruction, never
  touch leased devices, no implicit downloads, ownership proven not inferred,
  root validation fails closed, wire input is a claim not a fact.
- [testing.md](docs/internal/agent-rules/testing.md) — a test's title is a claim its
  body must prove; every test must be able to fail for the right reason;
  untested code is code you can delete with a green suite.
- [documentation.md](docs/internal/agent-rules/documentation.md) — end-user
  docs (`docs/`) vs. maintainer/agent docs (`docs/internal/`); no ADR links
  or internal-doc links from end-user docs; nothing the tool prints names a
  file path in this repo.
- [delivery.md](docs/internal/agent-rules/delivery.md) — GitHub Issues as
  spec and queue: one `<kind>:<state>` label per issue, agents act only on
  `*:ready` and `bug:triage`, the body is the spec and comments are
  discussion, reporters' issues are never rewritten, branches are
  `<kind>/<n>`, handoffs are one `## Handoff` comment per stop.

So are the accepted records in [docs/internal/adr/](docs/internal/adr/). An ADR marked
_Accepted — not yet implemented_ means the documentation already describes the
decided end state while the code has not caught up: treat the docs as the
specification, and do not "fix" them back to match current behaviour.

## Documentation

[docs/internal/agent-rules/documentation.md](docs/internal/agent-rules/documentation.md)
governs the split below — read it before adding or editing any doc.

End-user docs live directly under [docs/](docs/) and must stay self-contained
(no ADR links, no links into `docs/internal/`):

- [ABOUT.md](docs/ABOUT.md) — what the tool is and the problem it solves
- [CLI.md](docs/CLI.md) — the CLI command surface (user manual)
- [CLIENT.md](docs/CLIENT.md) — the programmatic client (`simlock/client`, `simlock/admin`)
- [CONFIGURATION.md](docs/CONFIGURATION.md) — every config key, its default, and how limits interact
- [HTTP-API.md](docs/HTTP-API.md) — the network-facing HTTP API
- [EVENTS.md](docs/EVENTS.md) — catalog of business events, end-user cut

Maintainer/agent docs live under [docs/internal/](docs/internal/):

- [ARCHITECTURE.md](docs/internal/ARCHITECTURE.md) — high-level architecture overview
- [DELIVERY.md](docs/internal/DELIVERY.md) — how work flows through GitHub
  Issues: the three walkthroughs, handoffs, what is automated, where ADRs fit
- [templates/](docs/internal/templates/) — the feature and task spec bodies a
  spec session writes
- [EVENTS.md](docs/internal/EVENTS.md) — the same catalog with rationale and ADR references
- [IDEAS.md](docs/internal/IDEAS.md) — post-v1 ideas; don't implement these unless asked
- [KNOWN-PITFALLS.md](docs/internal/KNOWN-PITFALLS.md) — accepted gaps and their planned fixes
- [adr/](docs/internal/adr/) — architecture decision records and their status
