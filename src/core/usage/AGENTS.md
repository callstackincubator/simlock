# Usage

Does: the figures behind `usage.get`, computed from the rows of `history.db` on a read thread.
Entry: `index.ts` → `createUsageReader(deps)` → `{ get(input), stop() }`, one per dispatcher (worker or gateway).
Uses: contract (types), history (`openUsageReads`, row types), ports (`NodeSqliteOpener`). Never imports: leasing, drivers, daemon, gateway.
Callers: `daemon/dispatcher.ts`, `gateway/dispatcher.ts`. See [history](../../history/AGENTS.md) for the rows.

## Files

| File               | Role                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `index.ts`         | `createUsageReader`: floors the window, owns the thread, joins token labels |
| `read-thread.ts`   | Worker-thread entry: opens `history.db` read-only, reads, computes          |
| `compute-usage.ts` | Pure: rows in, `UsageOutput` out; `usageBucket` picks the bucket width      |

## How it works

1. `get` answers `unavailable` when `opened()` is false, without posting to the thread.
2. `usageBucket(from, to)` picks the narrowest of 1, 5, 15 min, 1, 6 h, 1 day whose floored window has at most 200 points; `from` is floored to it, `to` is as asked.
3. One thread, started on the first read, unreferenced. A second `get` for the same floored window while one runs gets the same promise; another window is another read.
4. The thread opens a read-only connection per read, runs one read transaction (`oldestTs`, `requestRows`, `minuteBuckets`, `deviceFacts`) and answers `not-kept` when the oldest row is later than `to`.
   4a. With `includeLedger` the thread, after the transaction commits, also turns the window's request rows into `requests[]` (`ledgerOf`, newest 100,000, `ledgerTruncated` when cut); labels join as for requesters. The in-flight key includes `includeLedger`.
5. Minute figures read whole minutes only (the minute still running at `to` is left out), so a restart does not change them.
6. Labels are joined on the main thread from a fresh `tokenLabels()`; a gateway takes its `requesterPrefix` off an id first.

## Rules

- Counting, samples, scopes and coverage live in `compute-usage.ts` only (architecture rule 10).
- A read that throws, a thread that exits, or no answer in 30 s fails the call in flight; the next call starts a new thread.
- `stop()` terminates the thread; the dispatchers call it from `dispose`.
- Under tests the thread runs the `.ts` file with a resolve hook that maps `.js` imports to `.ts`.
