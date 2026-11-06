# Usage

Does: the figures behind `usage.get`, computed from the rows of `history.db` on a read thread.

## Rules

- Counting, samples, scopes and coverage live in `compute-usage.ts` only (architecture rule 10). The rows are [history](../../history/AGENTS.md)'s.
- A `get` for the same floored window joins the read already running. The in-flight key also holds `includeLedger`.
- Minute figures read whole minutes only (the minute still running at `to` is left out), so a restart does not change them.
- Labels are joined on the main thread from a fresh `tokenLabels()`; a gateway takes its `requesterPrefix` off an id first.
- A read that throws, a thread that exits, or no answer within `READ_TIMEOUT_MS` (`index.ts`) fails the calls in flight; the next call starts a new thread.
- `stop()` terminates the thread; the dispatchers call it from `dispose`.
- Under tests the thread runs the `.ts` file with a resolve hook that maps `.js` imports to `.ts`.
