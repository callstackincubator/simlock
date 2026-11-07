# Agent-device edge

Does: runs two agent-device daemons per worker (the simulator daemon over Simlock's simulator set, the phone daemon beside it with no set) and serves the agent-device CLI at `/v1/agent-device/*`, one simlock lease per agent-device lease.

## Rules

Boundaries:

- The simlock lease is the only clock; an agent-device lease never outlives it.
- The edge imports nothing from the gateway or the drivers, and names no gateway type: `gateway.ts` builds the `FleetPort` from its gateway context. No dependency rule holds this.
- Front map, renewals and release scopes live in memory only.

On and off:

- When the module is on only by default and the command is not found, the capability reads `off` and `agentDeviceFindings` says nothing (`isAbsentByDefault`). Every other trouble, and a not-found with `enabled: true` set, stays `unavailable` with its finding.
- The capability follows the simulator daemon; doctor lists a finding per daemon.
- Only `start-failed` retries; every other `unavailable` reason needs a daemon restart.

The two daemons:

- The phone daemon starts once the simulator daemon's start has settled. Simlock's start waits for neither.
- A pid taken from an earlier run's record is signalled only after its role's whole marker matches the end of its command line (`--simlock-home`, and `--simlock-role=phones` for the phone daemon), and it is checked again before SIGKILL.
- A daemon that survives its stop keeps its pid record, so the next start reaps it.
- The supervisor finds an installed agent-device; it never downloads one.
- A daemon's environment takes no `AGENT_DEVICE_*` key from the operator's shell. The phone daemon's also takes no simulator set and no driver lease key, and names the host's default adb server.
- A platform that is off is hidden from both daemons by a sentinel, not left to agent-device's own discovery.
- `AGENT_DEVICE_POLICY` (`shared/daemon-environment.ts`) keeps agent-device from booting or shutting down a device.
- `RoutedHostLink` sends a physical allocate, and every later call for that lease, to the phone daemon, and everything else to the simulator daemon. It forgets a lease when it ends.
- Each daemon has its own `ReleaseScopeRecord` and `AgentDeviceLeaseEnd`; for an ended lease only the one whose record holds its scope sends a release.

Front:

- The front serves the `agent` role only.
- `checkRequest` (`front/request-rules.ts`) runs before anything is forwarded: no platform but iOS and Android, no device selector but the leased one, no device set or allowlist, `install` only from an upload, `devices` alone and not streamed.
- `deviceExcept` becomes the lease's `except` in `stringFields` and is not forwarded to agent-device (`front/allocate.ts`).
- A `devices` answer is cut to the token's leases before the CLI gets it.
- The host sets the tenant to the requester's id and overwrites the client's.
- A heartbeat is forwarded with `ttlMs` raised to the ceiling (`agentDeviceLeaseMaxTtlMs`), then renews the simlock lease, with `lease.renew` only when it moves the deadline. When agent-device says the lease is gone, the simlock lease is released and the reply is "ended by simlock".
- On a gateway, a lease its `lease.list` omits is ended only when the index lost it (`HostLink.stillHeld`); a worker's list is final.
- A release goes to agent-device first, then `lease.release`.
- A command on a lease renews the simlock lease until its body ends (`Renewals`), never past `lease.maxTtlMs`.
- A reply naming `endedLeases` ends each simlock lease this token holds, as a release does: agent-device sends no release of its own for a lease it ended.
- `orientation` on an iOS phone or tablet simulator lease is Simlock's `device.rotate`, answered with agent-device's unconfirmed reply. Every other lease, and a batch step, forwards it.

Lease end and stop:

- `AgentDeviceLeaseEnd.leaseEnded` waits for a running allocate or release, then sends `agent_device.lease.release` with the recorded scope, under leasing's signal. It then removes that lease's folders under its daemon's `sessions/` (`<lease id>`, `<tenant>_<lease id>`, `<tenant>_<name>` for each `--session` name a command on the lease carried): agent-device removes none itself.
- Each daemon start empties that daemon's `sessions/` before agent-device runs: a restart ends every agent-device lease.
- A daemon stop cancels waiting allocates (`cancelWaitingAllocates`) and stops renewals.

Local profile ([ADR 0046](../../docs/internal/adr/0046-a-standalone-worker-serves-agent-device-by-default-with-a-private-profile.md)):

- `definition.ts` declares the profile file as plain data, and no worker code runs for it. The module host writes it at each start, reuses the one `agent` token with its label so an agent's saved connection stays valid, and revokes other tokens with that label.
- When HTTP or the module is off, the host deletes the file and revokes the token.

## Flow: agent on a worker

1. The agent-device CLI's `open` sends `agent_device.lease.allocate` with its own lease id to the front.
2. The front refuses what it cannot map, then asks leasing (`lease.request`) with that id as both the lease id and the requester id.
3. If the CLI hangs up while the request waits, the front cancels it (`lease.cancel`, retried until it is gone).
4. On the grant the front forwards the allocate to agent-device with the granted device's address in place of the CLI's device selectors (a phone's address is its enrolled id). `RoutedHostLink` picks the daemon.
5. agent-device refuses: the front releases the simlock lease. It accepts: the front keeps a map entry and relays the reply with the granted device added.
6. Commands carry the lease id: the request rules check them, renewals run, `devices` is filtered.
7. Release: agent-device first, then `lease.release`, which deletes the device; the lease end finds no scope left.

## Flow: through a gateway

1. The gateway's front runs the same rules; its link is `RelayHostLink`.
2. The allocate's `lease.request` requires the `agent-device` capability, so the gateway places it on a worker whose capability is available.
3. Every later call is relayed to the lease's worker with a tenant made from the gateway's instance id and the principal (`relayTenant`). A lease that is not the token's is refused with 403. Without a lease only `GET /health` is relayed, to the first undrained capable worker.
4. Relayed calls drop the client's `x-agent-device-instance` and `x-agent-device-upstream-instance` pins: they name the daemon `/health` was read from, not the lease's.
5. On the worker, `agentDeviceRelayTarget` hands the call to `RoutedHostLink` and the host, with the tenant as the requester. No front rules run on the worker.
6. Worker unreachable: the call answers "try again". A command so answered ends its renewal reference without releasing the lease or ending the worker's work; the last reference ends with one final renewal attempt.
7. A lease the index dropped is still routed for the gateway's `lease.maxTtlMs`. For `START_WINDOW_MS` (`front/relay-host-link.ts`) after a gateway start an unknown lease is unreachable, not refused.
8. After a gateway restart the front's map is empty: the token's `adoptable` leases are rebuilt into it before any rule reads it.

## Known gaps

- **A daemon restart loses agent-device leases.** The next heartbeat answers ended by simlock and the simlock lease is released. A call on a phone lease drops the client's instance pins too (`front/host-link.ts`), since they name the simulator daemon; so this holds for the phone daemon as well.
- **Agents sharing a token share a tenant**, and see each other's sessions.
