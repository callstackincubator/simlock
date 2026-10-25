# State

Does: opens a daemon's `state.db` in its data directory, refuses what it cannot trust, and migrates each owner's tables.
Entry: `index.ts` → `openStateDatabase(options)`, `StateDatabase`, `STATE_DB_NAME`.
Uses: ports (`SqliteOpener`, `Filesystem`, `Logger`, `SqliteSchemaOwner`). Never imports: core, leasing, daemon, drivers, gateway.
Imported by: daemon (opens it for both roles), core (`Registry` takes a `StateDatabase`).
Flows: [startup](../../docs/internal/flows/startup.md). Decision: [ADR 0036](../../docs/internal/adr/0036-daemon-state-is-a-sqlite-database-whose-tables-each-owner-keeps.md).

## Files

| File       | Role                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `index.ts` | the surface                                                                               |
| `open.ts`  | the old-file check, the open, `quick_check`, the version transaction, `transaction(work)` |

## How it works

1. **Old files.** Any of `oldFiles` in the data directory refuses the start; the message carries the role's `upgradeStep` with `<path>` replaced by the file found. Nothing is opened or created.
2. **Open.** `node:sqlite` missing refuses. The file opens (mode `0600`), then `busy_timeout=5000`, `journal_mode=WAL`, `synchronous=NORMAL`. A lock past 5 s refuses with the lock message; any other error refuses as damage (`open: <message>`).
3. **Check.** `PRAGMA quick_check` must answer exactly one `ok` row; anything else refuses as damage (`quick_check: <first row>`).
4. **Versions.** In one `BEGIN IMMEDIATE` transaction: create `schema_versions`, then for each owner read its version, refuse a newer one, run `migrations[from]` for each step up and write the version. A throw rolls back every owner's steps and refuses with the migration message. Reading inside the write transaction makes two daemons starting at once migrate once.
5. **Use.** `transaction(work)` runs `work` in a `BEGIN IMMEDIATE` and rolls back on a throw. The caller owns its tables; this module never reads them.

## Rules

- `state.db` is never deleted or renamed by Simlock; a refusal leaves it untouched.
- Each owner creates only its own tables and keeps its own version in `schema_versions`.
- A refusal is a thrown `Error` whose message is the user-facing text; the daemon logs it as `Daemon failed to start`.
- The module has no table of its own except `schema_versions`.
