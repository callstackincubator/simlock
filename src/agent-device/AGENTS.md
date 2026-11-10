# Agent-device edge

Does: runs two agent-device daemons per worker (the simulator daemon over Simlock's simulator set, the phone daemon beside it with no set) and serves the agent-device CLI at `/v1/agent-device/*`, one simlock lease per agent-device lease.

## Rules

Boundaries:

- The simlock lease is the only clock; an agent-device lease never outlives it.
- The edge imports nothing from the gateway or the drivers and names no gateway type: `gateway.ts` builds the `FleetPort`. No dependency rule holds this.
- Front map, renewals and release scopes live in memory only.

On and off:

- When the module is on only by default and the command is not found, the capability reads `off` and `agentDeviceFindings` says nothing (`isAbsentByDefault`). Every other trouble, and a not-found with `enabled: true` set, stays `unavailable` with its finding.
- The capability follows the simulator daemon; doctor lists a finding per daemon.
- Only `start-failed` retries; every other `unavailable` reason needs a daemon restart.

The two daemons:

- The phone daemon starts after the simulator daemon's start settles. Simlock's start waits for neither.
- A pid from an earlier run's record is signalled only after its role's whole marker matches the end of its command line (`--simlock-home`, and `--simlock-role=phones` for the phone daemon), and it is checked again before SIGKILL.
- A daemon that survives its stop keeps its pid record for the next start to reap.
- The supervisor never downloads agent-device.
- A daemon's environment takes no `AGENT_DEVICE_*` key from the operator's shell. The phone daemon's also takes no simulator set and no driver lease key, and names the host's default adb server.
- A platform that is off is hidden from both daemons by a sentinel.
- `AGENT_DEVICE_POLICY` (`shared/daemon-environment.ts`) keeps agent-device from booting or shutting down a device.
- `RoutedHostLink` sends a physical allocate, and later calls forwarded for that lease, to the phone daemon, and everything else it forwards to the simulator daemon. It forgets a lease when it ends.
- Each daemon has its own `ReleaseScopeRecord` and `AgentDeviceLeaseEnd`; for an ended lease only the one whose record holds its scope sends a release.

Front:

- The front serves the `agent` role only.
- `checkRequest` (`front/request-rules.ts`) runs before anything is forwarded: no platform but iOS and Android, no device selector but the leased one, no device set or allowlist, `install` only from an upload, `devices` alone, forwarded without `requestProgress`.
- A `devices` answer is cut to the token's leases.
- The host sets the tenant and overwrites the client's. A call that names a lease gets a tenant made from the principal and the lease id (`shared/tenant.ts`), so each lease's sessions, uploads and artifacts are its own; a call naming none keeps the principal. A relayed call keeps the gateway's tenant, which names the lease already. On a worker, a non-RPC call whose lease header names a lease the token does not hold is refused 403.
- A heartbeat is forwarded with `ttlMs` raised to the ceiling (`agentDeviceLeaseMaxTtlMs`), then renews the simlock lease (`lease.renew` only when it moves the deadline). On `LEASE_NOT_FOUND` for a lease simlock still holds, the front allocates it again on the same device, one at a time per lease and within a bound, and answers the heartbeat again; a failed re-allocate is a retryable reply that keeps the simlock lease. `LEASE_EXPIRED`, `LEASE_REVOKED`, a lease agent-device ended itself, and a lease simlock no longer holds release the simlock lease: "ended by simlock".
- On a gateway, a lease `lease.list` omits is ended only when the index lost it (`HostLink.stillHeld`); a worker's list is final.
- A release goes to agent-device first, then `lease.release`.
- After a standalone worker restarts, the token's leases the front made are rebuilt into its map (`adoptable`, `front/host-link.ts`), so a live lease keeps working.
- A command on a lease runs through `Renewals`, renewing the simlock lease until it ends, never past `lease.maxTtlMs`; standalone `boot` checks liveness without renewing.
- A reply naming `endedLeases` ends each simlock lease this token holds, as a release does: agent-device sends no release of its own for a lease it ended.
- A `close` (or batch with one) whose reply names a closed session and no `endedLeases` ends the simlock lease only for an entry allocated again after agent-device forgot it, without `retainOnClose`. An `adopted` entry's close is agent-device's.
- Standalone `boot` on a leased device is answered by the front; in a batch, agent-device's policy refuses the step.
- `orientation` on an iOS phone or tablet simulator lease is Simlock's `device.rotate`, answered with agent-device's unconfirmed reply. Everything else forwards it.

Lease end and stop:

- `AgentDeviceLeaseEnd.leaseEnded` waits for a running allocate or release, sends `agent_device.lease.release` with the recorded scope under leasing's signal, then removes that lease's folders under its daemon's `sessions` folder: agent-device removes none itself.
- Each daemon start empties that daemon's `sessions` folder before agent-device runs: it holds the previous daemon's sessions.

Local profile ([ADR 0046](../../docs/internal/adr/0046-a-standalone-worker-serves-agent-device-by-default-with-a-private-profile.md)):

- `definition.ts` declares the profile file as plain data, and no worker code runs for it. The module host writes it at each start, reuses the one `agent` token with its label so an agent's saved connection stays valid, and revokes other tokens with that label.
- With HTTP or the module off, the host deletes the file and revokes the token.

## Flow: agent on a worker

1. The agent-device CLI's `open` sends `agent_device.lease.allocate` with its own lease id to the front.
2. The front refuses what it cannot map, then asks leasing (`lease.request`) with that id as lease id and requester id.
3. If the CLI hangs up while the request waits, the front cancels it.
4. On the grant the front forwards the allocate to agent-device with the granted device's address in place of the CLI's device selectors.
5. agent-device refuses: the front releases the simlock lease. It accepts: the front keeps a map entry and relays the reply with the granted device added.
6. Release: agent-device first, then `lease.release`; the lease end then finds no scope.

## Flow: through a gateway

1. The gateway's front runs the same rules; its link is `RelayHostLink`.
2. The allocate's `lease.request` requires the `agent-device` capability, so the gateway places it on a worker where it is available.
3. Calls forwarded to the lease's worker carry a tenant made from the gateway's instance id, the principal and the lease id (`relayTenant`); standalone `boot` is answered by the gateway front instead. A lease that is not the token's is refused 403. Without a lease only `GET /health` is relayed.
4. Relayed calls drop the client's `x-agent-device-instance` and `x-agent-device-upstream-instance` pins: they name the `/health` daemon, not the lease's.
5. On the worker, `agentDeviceRelayTarget` hands the call to `RoutedHostLink` and the host, with the tenant as the requester. No front rules run on the worker.
6. Worker unreachable: the call answers "try again"; a command so answered ends its renewal reference, releasing nothing.
7. A lease the index dropped is still routed for `lease.maxTtlMs`. For `START_WINDOW_MS` (`front/relay-host-link.ts`) after a gateway start an unknown lease is unreachable, not refused.
8. After a gateway restart the front's map is empty: the token's `adoptable` leases are rebuilt into it before any rule reads it.

## Known gaps

- **A call on a phone lease drops the client's instance pins too** (`front/host-link.ts`): they name the simulator daemon.
- **Calls that name no lease share the token's tenant**: `session list` and an upload with no lease header see what every run of the token left.
