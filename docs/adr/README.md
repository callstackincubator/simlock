# Architecture decision records

One file per decision that shapes the system and would be expensive to
reverse. An ADR explains *why* a choice was made, so a later reader (human or
agent) can tell a deliberate constraint from an accident.

Naming: `NNNN-kebab-case-title.md`, numbered in the order decisions are
accepted. Numbers are never reused, and an ADR is never edited to say
something different — a decision that changes gets a new ADR that supersedes
the old one, and the old one's Status is updated to point at it.

Status values:

- **Proposed** — under discussion, not binding.
- **Accepted** — binding. Code that contradicts it is a bug.
- **Accepted — not yet implemented** — binding as a target. The docs describe
  the decided end state; the code has not caught up. Anyone implementing
  toward it should treat the documentation as the specification.
- **Superseded by NNNN** — no longer binding; read the replacement.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-simlock-owned-device-roots.md) | Simlock-owned device roots | Accepted — not yet implemented |
| [0002](0002-opt-in-slim-ios-simulators.md) | Opt-in slim iOS simulators | Accepted |
| [0003](0003-one-typed-daemon-contract-behind-every-frontend.md) | One typed daemon contract behind every frontend | Accepted |
