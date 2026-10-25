# Event history

Does: the durable record of every business event, one SQLite file, `history.db`, in the data directory.
Entry: `index.ts` → `createEventHistory()`, `openHistoryReader()`, `HistoryProjectionDefinition`, `HISTORY_PROJECTIONS`, `HISTORY_DB_NAME`, `openUsageReads()`.
Uses: bus (type, subscription), contract (`EVENT_ID_PATTERN`), ports (`SqliteOpener`, `Filesystem`, `Clock`, `Logger`). Never imports: core, leasing, drivers, gateway. Imported by daemon, cli (reader), gateway (type) and core (`src/core/usage/` imports `openUsageReads`, `DeviceFactRow`, `MinuteBucket` and `RequestRow`).
Flows: [startup](../../docs/internal/flows/startup.md). Catalog: [EVENTS.md](../../docs/internal/EVENTS.md).

## Files

| File           | Role                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `index.ts`     | the handle (`replay`, `replayPage`, `status`, `start`, `stop`) and the CLI reader                |
| `database.ts`  | pragmas, schema, the read query (`quick_check` and the lock-error test are in `ports/sqlite.ts`) |
| `prune.ts`     | age, size, projection prune, vacuum and checkpoint                                               |
| `versions.ts`  | `projection_versions`: migrate, refuse, the rebuild mark                                         |
| `rebuild.ts`   | refills a projection from the kept events, 1 000 at a time                                       |
| `set-aside.ts` | renames a damaged file and its `-wal` and `-shm`                                                 |
| `projections/` | `HISTORY_PROJECTIONS`: one directory per projection (`usage`)                                    |
| `testing.ts`   | a reader, a seeder, a probing opener and a fixed handle for tests                                |

## How it works

1. **Create** — the factory subscribes to the bus and touches no file. `status()` is `{ opened: false, writing: false }`; `replay` answers the ring.
2. **Start** — `start()` runs once the daemon holds its socket: load `node:sqlite`, open `history.db`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL`, `journal_mode=WAL`, `synchronous=NORMAL`, schema, `quick_check`. Then each projection is migrated to its code's version (see Projections). A file that fails to open or check is set aside (`history.db.damaged-<now>`, `-wal` and `-shm` first, main file last), and a fresh one opens.
3. **Catch up** — the ring's events are written in `seq` order, not time order (`INSERT OR IGNORE` by `id`; `index.ts` `#start`). After a set-aside only the events seen since the factory ran are. A projection whose check failed takes no step meanwhile.
4. **Write** — each event is one transaction: `BEGIN`, insert the row, run every projection's `apply` when the row is new, `COMMIT`.
5. **Prune** — after start and every hour: delete rows older than `eventLog.retention`, then the oldest 1 000 at a time while the stored size is over `eventLog.maxBytes`, then each projection's `prune` (rows older than `metrics.retention`), then `incremental_vacuum` and `wal_checkpoint(TRUNCATE)`.
6. **Read** — `replay({ sinceTs?, workerId? })` selects `timestamp > ?` ordered by timestamp, seq, rowid; a row whose id fails `EVENT_ID_PATTERN` is skipped. `openHistoryReader` does the same read-only for the CLI when no daemon answers; a missing file is empty, an unreadable one throws. `replayPage({ beforeId?, limit, workerId? })` never throws: with `beforeId` it selects the `limit` rows before that row's `(timestamp, seq, rowid)` and returns them oldest first (`not-kept` with the oldest row's timestamp when the id is not stored and the table has rows, `unavailable` when the file is not readable or not writing or the read fails); without it, the newest `limit` rows, or the ring's newest when the file is not readable or not writing or the read fails.
7. **Stop** — `stop()` cancels the timer and closes the file. A `start()` still awaiting closes what it opened and returns.

## State and timers

| What                                     | Default                       | Key                  |
| ---------------------------------------- | ----------------------------- | -------------------- |
| Keep events for                          | 7 days                        | `eventLog.retention` |
| Keep projection rows for                 | 90 days, at least the events' | `metrics.retention`  |
| Cap on the stored size of the event rows | 256 MiB (at least 16 MiB)     | `eventLog.maxBytes`  |
| Prune                                    | after start, then hourly      | none                 |
| Wait on another connection's lock        | 5 s                           | none                 |

- `status()` feeds `status.get` `history`: `opened`, `writing`, `setAsideAt`, `rebuiltAt`, `rebuildFailed`.
- A failed write rolls back, logs one `error`, and sets `writing` false until restart. A storage failure also sends `replay` back to the ring; a projection failure leaves the file readable.
- A lock held past 5 s is never damage: nothing is set aside.
- The file lives on the real disk: the daemon builds the history with its own `NodeFilesystem`.

## Projections

- A definition has a `version`, one migration per step (`migrations[n]` takes `n` to `n + 1`), a `check` and a `create(database, { fleet, metricsRetentionMs })` that returns `apply`, `prune` and `rebuild`. `usage` is the first.
- **Version.** `projection_versions(name, version, rebuilding)`. A stored version above the code's, or a migration that throws, makes `start()` reject naming the projection and both versions; nothing is dropped and the daemon stops (`history-refused`, exit 1).
- **Check.** False when a rebuild is marked running or `check(database)` says a table or column is missing or has another type. False rebuilds, after the start prune and before the prune timer is armed.
- **Rebuild.** Marks the projection running in the database, calls `rebuild(oldestEventAt)` when the projection has one (it recreates failing tables and clears the rows the kept events cover), then replays the events by `rowid`, 1 000 a batch, one transaction each, yielding with `setImmediate`. Events written meanwhile are inserted without a step and the cursor reaches them; the last batch clears the mark and resumes live steps in the same tick. A stop leaves the mark. A throw logs one `error`, sets `rebuildFailed`, leaves the deleted rows deleted and the projection takes no step for the run; events still go in.

### The usage projection (`projections/usage/`)

- Tables: `request_rows` (one per lease request), `minute_rows` (per `workerId`, `platform`, minute), `device_fact_rows`, `gaps`, `held_leases`. `workerId` is `""` for the daemon's own, `*` for a gateway's fleet total; `platform` is `ios` or `android` (any other payload value is dropped) or `all`.
- `projections/usage/projector.ts` reads each payload field bounded (strings cut to 200, numbers finite and non-negative, enums checked): a field that fails is absent, a missing key id changes no row. On a gateway only its own `lease.requested`, `-rejected` and `request.granted` make request rows; relayed grants and ends fill `held_leases` and join `source` and `heldMs` by `(workerId, workerLeaseId)`.
- `projections/usage/minutes.ts` writes a row only for a minute in which a value changed. A row holds `peak`, `last` and `integral` per value, the integral taken through the minute's end as if the last value held, and `knownMs`. A step stamped before its key's last step counts at that step. A cut (`daemon.stopping`, a gateway's `worker.disconnected`) trims the row and sets `carryUntil`; `gaps` records those and `daemon.started`, one marker per instant, the widest kept. A start keeps the levels its convergence set before it. The first step of a key in a run, and the start for the keys left, close the key's last open row, so nothing carries over a crash. A replay has no process start, so `apply` takes an envelope whose `seq` does not rise (`projections/usage/projector.ts` `apply`) as a new run and forgets the key states, levels, connected workers and queue depths the earlier run left, which makes a rebuild equal the live rows across a crash.
- `projections/usage/reads.ts` (`openUsageReads`) answers `oldestTs`, `requestRows`, `minuteBuckets` and `deviceFacts` on a read-only connection; a bucket carries each value across minutes with no row up to the next row, `carryUntil` or `to`.
- Counts (`waiting`, held leases) are restored from the tables on first use; `waiting` ignores probes.

## Rules

- The history deletes rows, never files. A set-aside file is renamed, never deleted.
- Only the socket-claim holder starts it, so a second daemon never opens, checks or renames the file.
- A failing write never reaches the emitter (events rule 5).
- The history's own code (`database.ts`, `versions.ts`, `rebuild.ts`, `prune.ts` and the write path in `index.ts`) never names a projection (architecture rule 21); the host hands `HISTORY_PROJECTIONS` in. `index.ts` only re-exports that registry and the usage read side (`openUsageReads`, `DeviceFactRow`, `MinuteBucket`, `RequestRow`) for the readers; `core/usage` is the reader of `usage.get`.

## Known gaps

- **Power loss.** The last few commits can be lost (`synchronous=NORMAL`).
- **Old `events.jsonl`.** Left untouched and never read.
