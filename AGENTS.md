# Agent guide

Simlock is a control plane for iOS simulators and Android emulators that lets
parallel coding agents lease devices without fighting over them.

## Rules — read before writing code

The rules in [docs/agent-rules/](docs/agent-rules/) are binding for all
changes in this repo:

- [architecture.md](docs/agent-rules/architecture.md) — loosely coupled
  modules; platform-agnostic core; iOS and Android encapsulated in their own
  driver modules; event bus for observers only.
- [events.md](docs/agent-rules/events.md) — event naming
  (`subject.past-tense-fact`), post-commit emission, payload contracts,
  keeping EVENTS.md in sync.
- [safety.md](docs/agent-rules/safety.md) — registry-only destruction, never
  touch leased devices, no implicit downloads.

## Documentation

Useful documentation lives in [docs/](docs/):

- [ABOUT.md](docs/ABOUT.md) — what the tool is and the problem it solves
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — high-level architecture overview
- [CLI.md](docs/CLI.md) — the expected CLI command surface (user manual)
- [EVENTS.md](docs/EVENTS.md) — catalog of business events
- [IDEAS.md](docs/IDEAS.md) — post-v1 ideas; don't implement these unless asked
- [known-pitfalls.md](docs/known-pitfalls.md) — accepted gaps and their planned fixes
