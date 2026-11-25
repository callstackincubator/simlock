# Lease policy

Does: the client-side renew timer the CLI and MCP share — renew at a third of the TTL — and the slim-lease hint line both print.

## Rules

- Call `stop()` before releasing, so a renew never races the release.
- `UNKNOWN_LEASE`, `FORBIDDEN` or a passed deadline ends it: `onLeaseGone` once. Any other failure goes to `onError` and is retried.
- Not exported from `simlock/client` or `simlock/admin`.
- The slim hint reads only the catalog, within 2 s; a failed or late read is no hint, never an error.
