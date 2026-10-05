# Architecture decision records

One file per decision that shapes the system and would be expensive to
reverse. An ADR explains *why* a choice was made, so a later reader (human or
agent) can tell a deliberate constraint from an accident.

Naming: `NNNN-kebab-case-title.md`, numbered in the order decisions are
accepted. Numbers are never reused, and an ADR is never edited to say
something different — a decision that changes gets a new ADR that supersedes
the old one, and the old one's Status is updated to point at it.

Show the decision, not only describe it. Where it helps the reader, add
Mermaid diagrams: a flowchart of the modules or processes involved and how
they depend on each other, before and after the decision; a sequence
diagram of a request or flow the decision changes, failure paths included;
a state diagram when it changes the states a lease, device or worker can
be in. Each diagram has at most about ten boxes, and the text still states
the decision on its own.

Status values:

- **Proposed** — under discussion, not binding.
- **Accepted** — binding. Code that contradicts it is a bug.
- **Accepted — not yet implemented** — binding as a target; the code has not
  caught up. The ADR and the spec of the issue that links it are the
  specification. The PR that implements a change updates the docs it makes
  true. ADRs 0004 and 0005 were accepted with their docs already rewritten to
  the end state; for those two the docs are the specification too, and
  nobody "fixes" them back to match current behaviour.
- **Superseded by NNNN** — no longer binding; read the replacement.

An ADR's status follows the feature that produced it, per
[agent-rules/delivery.md](../agent-rules/delivery.md): it is *Proposed*
while the feature is still `feature:spec`, becomes *Accepted — not yet
implemented* when the feature leaves that state, and becomes *Accepted*
when the feature closes. An ADR that is *Accepted — not yet implemented*
with no open feature behind it is a gap: either the feature is missing or
the status is stale.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-simlock-owned-device-roots.md) | Simlock-owned device roots | Accepted |
| [0002](0002-opt-in-slim-ios-simulators.md) | Opt-in slim iOS simulators | Accepted |
| [0003](0003-one-typed-daemon-contract-behind-every-frontend.md) | One typed daemon contract behind every frontend | Accepted |
| [0004](0004-ttl-first-leases-on-every-transport.md) | TTL-first leases on every transport | Accepted — not yet implemented |
| [0005](0005-gateway-and-worker-modes.md) | Gateway and worker modes | Accepted — not yet implemented |
| [0006](0006-events-and-log-are-two-records.md) | Events and the daemon log are two records | Accepted |
| [0007](0007-a-lease-request-chooses-the-device-mode.md) | A lease request chooses the device mode | Accepted — not yet implemented |
| [0008](0008-the-catalog-pairs-models-with-runtimes-and-status-carries-host-facts.md) | The catalog pairs models with runtimes, and status carries host facts | Accepted — not yet implemented |
| [0009](0009-gateway-routing-is-a-list-of-stages.md) | Gateway routing is a list of stages, and a request that cannot be served fails at once | Accepted — not yet implemented |
| [0010](0010-components-have-one-owner-in-the-core.md) | Components are installed, recorded and removed through one owner in the core | Accepted |
| [0011](0011-the-console-is-a-built-app-the-daemon-serves.md) | The console is a built app the daemon serves at `/` | Accepted — not yet implemented |
| [0012](0012-a-worker-answers-the-fleet-operations-as-a-fleet-of-one.md) | A worker answers the fleet operations as a fleet of one | Accepted — not yet implemented |
| [0013](0013-the-console-reads-routes-and-follows-the-event-stream.md) | The console reads the routes and follows the event stream | Accepted — not yet implemented |
| [0014](0014-an-event-has-one-id-minted-where-the-fact-happened.md) | An event has one id, minted where the fact happened | Accepted |
| [0015](0015-a-lease-request-is-a-set-of-constraints.md) | A lease request is a set of constraints, and the catalog says which class each model is | Accepted — not yet implemented |
| [0016](0016-usage-figures-are-derived-on-read-from-the-event-history.md) | Usage figures are derived on read from the event history | Accepted — not yet implemented |
| [0017](0017-leasing-is-one-module-and-every-module-is-entered-through-its-index.md) | Leasing is one module, and every module is entered through its index | Proposed |
| [0018](0018-startup-ends-every-lease-whose-device-is-not-running.md) | Startup ends every lease whose device is not running | Proposed |
