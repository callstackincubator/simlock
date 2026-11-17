# Event history

Does: the durable record of every business event, one SQLite file, `history.db`, in the data directory.
Flows: [startup](../../docs/internal/flows/startup.md). Catalog: [EVENTS.md](../../docs/internal/EVENTS.md).

## Rules

The file:

- The history deletes rows, never files. A damaged file is set aside by rename, never deleted: `-wal` and `-shm` first, the main file last. Then a fresh one opens.
- A lock held past the busy timeout is never damage: nothing is set aside, and events are not written.
- Only the socket-claim holder starts it, so a second daemon never opens, checks or renames the file.
- The file lives on the real disk: the daemon builds the history with its own `NodeFilesystem`.
- Never imports core, leasing, drivers or gateway.

Start and stop:

- The factory subscribes to the bus and touches no file. Until `start()` has opened the file, `replay` answers the ring.
- Catch-up writes the ring's events in `seq` order, not time order (`INSERT OR IGNORE` by `id`). After a set-aside only the events seen since the factory ran are written.
- A stored projection version above the code's, or a migration that throws, makes `start()` reject; nothing is dropped and the daemon stops (`history-refused`).
- A `start()` still awaiting when `stop()` runs closes what it opened and returns.

Writes:

- Each event is one transaction: the row, then every projection's `apply`, run only when the row is new.
- A failing write never reaches the emitter (events rule 5). It rolls back, logs one `error`, and sets `writing` false until restart. A storage failure also sends `replay` back to the ring; a projection failure leaves the file readable.
- An event `JSON.stringify` cannot serialize is dropped with one `error` and writing goes on. The gateway's `WorkerLink` already refuses such a relayed event, so this is the second guard.
- Prune order: events older than `eventLog.retention`, then the oldest while the stored size is over `eventLog.maxBytes`, then each projection's `prune` (`metrics.retention`), then vacuum and checkpoint.

Reads:

- Every read orders by timestamp, seq, rowid. A row whose id fails `EVENT_ID_PATTERN` is skipped.
- `replayPage` never throws: it answers `not-kept`, `unavailable`, or the ring's newest.
- `openHistoryReader` reads a missing file as empty; an unreadable one throws.

Projections:

- The history's own code never names a projection (architecture rule 21); the host hands `HISTORY_PROJECTIONS` in. `index.ts` only re-exports that registry and the usage read side for the readers; `core/usage` is the reader of `usage.get`.
- `migrations[n]` takes a projection from `n` to `n + 1`.
- A projection whose `check` fails, or whose rebuild mark is set, takes no step and is rebuilt after the start prune, before the prune timer is armed. Events written meanwhile go in without a step and the rebuild's cursor reaches them; the last batch clears the mark and resumes live steps in the same tick.
- The mark is kept in the database, so a stop or a crash mid-way rebuilds again at the next start.
- A rebuild that throws logs one `error`, sets `rebuildFailed`, and leaves the deleted rows deleted. The projection takes no step for the run; events still go in.

The usage projection (`projections/usage/`):

- `workerId` is `""` for the daemon's own rows and `*` for a gateway's fleet total. `platform` is `ios`, `android` or `all`; any other payload value is dropped.
- A relayed payload is a claim. `projections/usage/projector.ts` reads each field bounded: a field that fails is absent, and a missing key id changes no row.
- On a gateway only its own `lease.requested`, `lease.rejected` and `request.granted` make request rows. Relayed grants and ends fill `held_leases` and join by `(workerId, workerLeaseId)`.
- `projections/usage/minutes.ts` writes a row only for a minute in which a value changed. Its integral runs through the minute's end as if the last value held, and `projections/usage/reads.ts` carries each value across the minutes with no row.
- A cut (`daemon.stopping`, a gateway's `worker.disconnected`) trims the row and sets `carryUntil`.
- Nothing carries over a crash: the first step of a key in a run, and the start for the keys left, close the key's last open row. A start keeps the levels its convergence set before it.
- A replay has no process start, so `apply` takes an envelope whose `seq` does not rise as a new run and forgets what the earlier run left. That makes a rebuild equal the live rows across a crash.
- A step stamped before its key's last step counts at that step.
- Counts (`waiting`, held leases) are restored from the tables on first use; `waiting` ignores probes.

## Known gaps

- **Power loss.** The last few commits can be lost (`synchronous=NORMAL`).
- **Old `events.jsonl`.** Left untouched and never read.
