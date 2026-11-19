# State

Does: opens a daemon's `state.db` in its data directory, refuses what it cannot trust, and migrates each owner's tables.
Flows: [startup](../../docs/internal/flows/startup.md). Decision: [ADR 0036](../../docs/internal/adr/0036-daemon-state-is-a-sqlite-database-whose-tables-each-owner-keeps.md).

## Rules

- `state.db` is never deleted or renamed by Simlock; a refusal leaves it untouched.
- Any of `oldFiles` in the data directory refuses the start before anything is opened or created.
- A refusal is a thrown `Error` whose message is the user-facing text; the daemon logs it as `Daemon failed to start`.
- A lock held past the busy timeout refuses with the lock message, never as damage.
- Each owner creates only its own tables and keeps its own version in `schema_versions`, the one table this module has. This module never reads an owner's tables.
- All owners migrate in one write transaction: a throw rolls back every owner's steps, and a stored version newer than the code's refuses. The version is read inside that transaction, so two daemons starting at once migrate once.
- Imports ports only: never core, leasing, daemon, drivers or gateway.
