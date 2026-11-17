# Lease policy

Does: the client-side renew timer the CLI and MCP share — renew at a third of the TTL.

## Rules

- Call `stop()` before releasing, so a renew never races the release.
- `UNKNOWN_LEASE`, `FORBIDDEN` or a passed deadline ends it: `onLeaseGone` once. Any other failure goes to `onError` and is retried.
- `startReconnect` is a remote holder's reconnect: no try after the deadline, and a lost lease or a refused token or version ends it at once.
- Not exported from `simlock/client` or `simlock/admin`.
