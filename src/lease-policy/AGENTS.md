# Lease policy

Does: the client-side renew timer the CLI and MCP share — renew at a third of the TTL.

## Rules

- Call `stop()` before releasing, so a renew never races the release.
- `UNKNOWN_LEASE`, `FORBIDDEN` or a passed deadline ends it: `onLeaseGone` once. Any other failure goes to `onError` and is retried.
- `startReconnect` is the reconnect schedule of a remote holder: tries after 1, 2, 4, 8 s, then every 15 s, none after the deadline. A lost lease or a refused token or version ends it at once, and a callback of each ending runs once.
- Not exported from `simlock/client` or `simlock/admin`.
