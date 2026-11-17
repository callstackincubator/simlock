# stdio MCP server

Does: one agent session over stdin/stdout — its tools, a renew timer, lazy reconnect.
Surface: [connect-your-agent.mdx](../../website/src/content/docs/docs/getting-started/connect-your-agent.mdx), [cli.mdx](../../website/src/content/docs/docs/reference/cli.mdx).

## Rules

Session:

- The requester id (`resolveRequesterId`) is the principal. The session sends no credential, so it is always `agent`.
- stdout is the protocol. A push (lease lost, device unhealthy, device recovered) goes out as an MCP logging message.
- Every connect, a tool call's and a renew's, asks `resolveDaemonHome` again, so a gateway started mid-session is found. With `--gateway` and none present the connect throws `GATEWAY_NOT_PRESENT` before it connects.
- Never imports core, daemon, drivers or http: it reaches a daemon only through `simlock/client`. No lint rule holds this.
- `run_on_device` and `rotate_device` act on the held lease: their input never names a lease or a device. A non-zero exit is a result, not a tool error.

Connect and reconnect:

- The typed client never reconnects. `onConnectionLost` drops it and the next use builds a new one. The lease survives: the daemon released nothing.
- A tool call may launch a daemon (`connectWithAutoLaunch`), and only when nothing listens.
- The renew path never launches a daemon (`connectToRunningDaemon`), so an operator's `simlock daemon stop` sticks.
- No reconnect or launch on a version mismatch or a refused handshake.
- A launched daemon that exits fails the call at once, unless another daemon answers a last connect. A connection lost during the launched daemon's handshake is `DAEMON_STARTUP_FAILED`; a pre-existing daemon keeps `DAEMON_CONNECTION_LOST`.

Holding a lease:

- No lease cache: `lease_status` asks the daemon every time.
- The renewal stops before a release is sent; it restarts only if the daemon kept the lease.
- A grant that lands after `close()` is released at once and the call fails.
- The end (stdin EOF, a signal or a transport close) is `McpSession.close`: stop every renewal, release held leases within `RELEASE_TIMEOUT_MS` (lease-policy), then close the client.

## Known gaps

- **Under Codex and pi the session id is not visible.** Codex strips `CODEX_*` from MCP servers, and pi sets `PI_SESSION_ID` only for commands its `bash` and `powershell` tools run, so `simlock mcp` is `mcp:<pid>` while the CLI is `codex:<id>` or `pi:<id>`: two requesters, two leases. Use one interface per session, or set the same `SIMLOCK_AGENT_ID` for both.
