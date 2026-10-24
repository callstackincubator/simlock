# stdio MCP server

Does: one agent session over stdin/stdout — its tools, a renew timer, lazy reconnect.
Entry: `main.ts` → `runMcpStdio({ daemonFlag })`; `simlock mcp` loads it on demand (`src/cli/commands/mcp.ts`).
Uses: client, lease-policy, agent-identity, contract, ports, instructions. Never imports: core, daemon, drivers, http.
Surface: [connect-your-agent.mdx](../../website/src/content/docs/docs/getting-started/connect-your-agent.mdx), [cli.mdx](../../website/src/content/docs/docs/reference/cli.mdx).

## Files

| File              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `main.ts`         | `startMcpStdio`: requester id, session, server, transport, shutdown  |
| `session.ts`      | `McpSession`: one client at a time, serialized calls, renew, release |
| `server.ts`       | `createMcpServer`: the tools, the rules, progress, logging           |
| `contracts.ts`    | Tool schemas, cut from the contract's operations                     |
| `connect.ts`      | `connectWithAutoLaunch`, `connectToRunningDaemon`                    |
| `connect.test.ts` | The auto-launch loop's own test                                      |
| `test-support.ts` | Helpers for this module's tests                                      |

## How it works

1. **Start** — requester id from `resolveRequesterId(env, "mcp:<pid>")`. It is the
   principal; no credential, so the session is `agent`. The daemon follows the CLI's choice
   (`resolveDaemonHome` with `--gateway`, `--local` or neither); `simlock --gateway mcp` runs the
   session on the gateway. MCP adds no `--gateway` hint. Every connect (a tool call's and a renew's) asks
   `resolveDaemonHome` again, so a gateway started mid-session is found, and with none
   present the connect throws `GATEWAY_NOT_PRESENT` before it connects, which the tool
   reports as `{ code, message }`.
2. **Rules** (`server.ts`) — the server options carry `MCP_SERVER_INSTRUCTIONS` (at most 4096
   characters), and the resource `simlock://instructions` (`text/markdown`) returns `AGENT_INSTRUCTIONS`,
   the text `simlock instructions` prints.
3. **Tools** (`server.ts`), each one call on the typed client:
   - `lease_simulator` → `lease.request`. Input: the contract's lease fields minus
     `requesterId`, `fleetRequestId`, `requires`. Progress goes out as
     `notifications/progress`, only when the call carried a progress token.
   - `list_devices` → `catalog.get`.
   - `release_simulator` → `lease.release`. A lease not this principal's: the daemon's `FORBIDDEN`.
   - `lease_status` → `lease.list`, filtered to the held lease; `{ held: false }` when none.
   - `run_on_device` → `device.exec` on the held lease. Input: `tool`, `args`, `stdin?`, never a lease
     or device. Result `{ exitCode, stdout, stderr, truncated }`, each stream cut to its last
     32 768 characters; a non-zero exit is a result. No held lease: `NO_LEASE`. With a progress
     token: `notifications/progress` on the first output, then at most one a second, and every 10 s
     while silent (the session's clock).
4. **Serialize** — every tool call but `run_on_device` queues on one chain in `McpSession`;
   `run_on_device` does not queue, so `lease_status` and `release_simulator` run while a command does.
5. **Renew** — a grant starts `startLeaseRenewal` (lease-policy): every third of the TTL.
6. **Pushes** → MCP logging messages, logger `simlock`: lease lost (warning), device
   unhealthy (warning), device recovered (info).
7. **Reconnect** — the typed client never reconnects. `onConnectionLost` drops it; the next
   use builds a new one:
   - a tool call → `connectWithAutoLaunch`: launches the daemon only when nothing listens
     (`connection-refused`, `endpoint-not-found`), retries every 50 ms for
     `startupTimeoutMs` (default `DAEMON_STARTUP_TIMEOUT_MS`), else `DAEMON_STARTUP_FAILED` with
     the `daemon.log` lines since the start; the launcher is `launcherFor` (the service when
     loaded, else a spawn; `McpStdioEnvironment.serviceManager` lets a test pass a fake);
     a launched daemon that exits fails at once with `startErrorFrom`'s text, unless another
     daemon answers a last connect; a connection lost during the launched daemon's handshake
     is `DAEMON_STARTUP_FAILED`, while a pre-existing daemon keeps `DAEMON_CONNECTION_LOST`;
   - the renew timer → `connectToRunningDaemon`: never launches.
     The lease survives either way: the daemon released nothing.
8. **End** — stdin EOF, `SIGINT`/`SIGTERM` or transport close → `McpSession.close`: stop
   every renewal, release held leases within `RELEASE_TIMEOUT_MS` (5 s), close the client.

## Rules

- No lease cache: `lease_status` asks the daemon every time.
- The renew path never launches a daemon, so an operator's `simlock daemon stop` sticks.
- No reconnect or launch on a version mismatch or a refused handshake.
- The renewal stops before a release is sent; it restarts only if the daemon kept the lease.
- A grant that lands after `close()` is released at once and the call fails.

## Known gaps

- **Under Codex the session id is not visible.** Codex strips `CODEX_*` from MCP servers,
  so `simlock mcp` is `mcp:<pid>` while the CLI is `codex:<id>`: two requesters, two leases.
  Use one interface per session, or set the same `SIMLOCK_AGENT_ID` for both.
