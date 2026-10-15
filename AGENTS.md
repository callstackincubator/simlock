# Agent guide

Simlock is a control plane for iOS simulators and Android emulators that lets
parallel coding agents lease devices without fighting over them.

## Rules — read before writing code

The rules in [docs/internal/agent-rules/](docs/internal/agent-rules/) are binding for all
changes in this repo:

- [architecture.md](docs/internal/agent-rules/architecture.md) — loosely coupled
  modules; platform-agnostic core; iOS and Android encapsulated in their own
  driver modules; event bus for observers only; one place enforces a rule;
  bounded cross-process waits; every exit leaves one named state; a module
  hands out a capability, not its parts; an extension point only when a
  second implementation is named, in one shape; a host never names an
  implementation.
- [events.md](docs/internal/agent-rules/events.md) — event naming
  (`subject.past-tense-fact`), post-commit emission, payload contracts,
  keeping EVENTS.md in sync.
- [safety.md](docs/internal/agent-rules/safety.md) — registry-only destruction, never
  touch leased devices, no implicit downloads, ownership proven not inferred,
  root validation fails closed, wire input is a claim not a fact.
- [testing.md](docs/internal/agent-rules/testing.md) — a test's title is a claim its
  body must prove; every test must be able to fail for the right reason;
  what a caller can see is tested, and in a strict area every path is;
  test a module through its surface; prove each claim once, at the
  cheapest level.
- [documentation.md](docs/internal/agent-rules/documentation.md) — end-user
  docs (`docs/`) vs. maintainer/agent docs (`docs/internal/`); no ADR links
  or internal-doc links from end-user docs; nothing the tool prints names a
  file path in this repo; every module has a manual beside its code.
- [delivery.md](docs/internal/agent-rules/delivery.md) — GitHub Issues as
  spec and queue: one `<kind>:<state>` label per issue, agents act only on
  `*:ready` and `bug:triage`, the body is the spec and comments are
  discussion, reporters' issues are never rewritten, handoffs are one
  `## Handoff` comment per stop, every PR
  gets a spec, a code and a claims review before it leaves draft, agents merge
  only through `.agents/scripts/merge-pr.sh`, and the slow lane runs one
  at a time through its script.
- [coding.md](docs/internal/agent-rules/coding.md) — what an agent
  building a change needs: the body is the spec, small gaps are
  `Assumption:` lines, branches are `<kind>/<n>`, every agent is in a
  worktree, the PR proves its Done when.
- [toolchain.md](docs/internal/agent-rules/toolchain.md) — the commands
  agents run and the checks they leave to hooks and CI; the slow lane
  (real devices); project-only checks. Agents and skills take every command
  from here.
- [vendor-and-third-party-code.md](docs/internal/agent-rules/vendor-and-third-party-code.md)
  — third-party code lives under `vendor/`, one directory per upstream, each
  with its license text and a `NOTICE.md`; source vendoring records the commit,
  the deviations and how to diff against upstream; binaries are vendored
  byte-identical with a checksum; nothing is fetched at runtime.
- [always-in-scope.md](docs/internal/agent-rules/always-in-scope.md) — what
  every change includes without its spec asking (docs and strings it makes
  false, both `EVENTS.md` files, a test for every new path, Fallow entries),
  each item cited from the rules above; CI proves the suite.

So are the accepted records in [docs/internal/adr/](docs/internal/adr/). An ADR marked
_Accepted — not yet implemented_ is binding as a target while the code has not
caught up: build toward the ADR and the spec of the issue that links it. The
PR that implements a change updates the docs it makes true. Where the docs
already describe a decided end state the code has not reached (ADRs 0004 and
0005), treat them as the specification too, and do not "fix" them back to
match current behaviour.

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
- [CONSOLE.md](docs/CONSOLE.md) — the web console: turning it on, opening it, signing in
- [EVENTS.md](docs/EVENTS.md) — catalog of business events, end-user cut

**Module manuals.** Each module under `src/` has its own `AGENTS.md` in its root
(`src/leasing/AGENTS.md`, `src/drivers/android/AGENTS.md`, …): what it does,
how, its state and timers, the rules a change must not break, its known gaps.
Before you read, change or review code under `src/`, load the `AGENTS.md` of
every module directory on the path to that file, unless your tool has already
loaded it. A change that makes a manual false fixes it in the same change.

Maintainer/agent docs live under [docs/internal/](docs/internal/):

- [ARCHITECTURE.md](docs/internal/ARCHITECTURE.md) — the map: topology, every module
  and its manual, the enforced boundaries, the flows
- [DESIGN.md](docs/internal/DESIGN.md) — the design guide for the web console
  (and the landing page): type, colour, status colours, spacing, voice
- [DELIVERY.md](docs/internal/DELIVERY.md) — how work flows through GitHub
  Issues: the three walkthroughs, handoffs, what is automated, where ADRs fit
- [flows/](docs/internal/flows/) — paths that run through several modules:
  startup, device selection, `device.exec`
- [templates/](docs/internal/templates/) — the feature and task spec bodies a
  spec session writes, and the module manual template
- [EVENTS.md](docs/internal/EVENTS.md) — the same catalog with rationale and ADR references
- [IDEAS.md](docs/internal/IDEAS.md) — post-v1 ideas; don't implement these unless asked
- [VENDORED-CODE.md](docs/internal/VENDORED-CODE.md) — every third-party artifact in the
  repo: upstream, version, license, where it lives, who consumes it, how to re-verify
- [adr/](docs/internal/adr/) — architecture decision records and their status
