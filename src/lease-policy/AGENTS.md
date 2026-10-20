# Lease policy

Does: the client-side renew timer the CLI and MCP share — renew at a third of the TTL.
Entry: `index.ts` → `startLeaseRenewal(options)` → `{ stop() }`; `awaitWithin`, `RELEASE_TIMEOUT_MS` (5 s).
Uses: contract (`isSimlockError`), ports (`Clock`). Not exported from `simlock/client` or `simlock/admin`.

- Cadence from the lease's `ttlMs`, capped by `ttlDeadline`; delay floor 250 ms. Each attempt is
  bounded by a third of what is left.
- `UNKNOWN_LEASE`, `FORBIDDEN` or a passed deadline ends it: `onLeaseGone` once
  (`renew-rejected` | `renew-failed`). Any other failure goes to `onError` and is retried.
- Call `stop()` before releasing, so a renew never races the release.
