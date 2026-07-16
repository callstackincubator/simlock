# Stage 09 — Daemon & IPC protocol

Goal: the long-lived daemon that owns the core, and the unix-socket protocol
the CLI speaks — including the load-bearing semantic: **connection close
releases held leases**.

## Implement (in `src/daemon/`)

- **Protocol**: newline-delimited JSON over `node:net` unix socket at
  `~/.pitlane/daemon.sock`. Message envelope `{id, type, payload}`;
  responses `{id, ok, payload | error: {code, message}}`; server-push frames
  (no id): `{push: 'progress' | 'event', payload}`. First message must be
  `hello {protocolVersion, clientVersion}`; version mismatch → typed error,
  connection closed.
- **Request types** (map 1:1 to core calls): `lease.request` (params from
  CLI.md; requesterId = provided by client, default its PID),
  `lease.release`, `lease.renew`, `status.get`, `list.get`,
  `cleanup.run {dryRun, rule?}`, `events.replay {sinceTs}`,
  `events.subscribe` (push frames until unsubscribe/close), `config.get`,
  `daemon.stop`.
- **Held-lease semantics**: a lease requested with `mode: 'held'` is bound
  to the connection; socket close/error → `release(leaseId, 'closed')`.
  Progress during acquisition (provisioning/booting, with driver estimates)
  streams as push frames on that connection.
- **Lifecycle**: startup = claim socket (stale socket detection: connect
  fails ECONNREFUSED → unlink and bind), load config + registry, run startup
  reconcile (mark registry devices whose backing device is gone — full
  doctor logic lands in stage 13; here: drivers absent, so just emit
  `daemon.started`), start reaper timers. Graceful stop: emit
  `daemon.stopping`, stop accepting, release held leases, flush registry,
  exit. Single-instance: bind failure with a live daemon → error.
- Wire-up module (`src/daemon/main.ts`): construct real ports, bus, registry,
  config, engine, reaper, drivers map (empty/fake for now — real drivers
  register in stages 11/12), server.

## Tests first (in-process server on a temp socket path; real net, fake core deps)

- hello handshake required; wrong version rejected.
- lease.request over a connection, then socket destroy → lease released
  (engine observed the release; queued waiter on second connection gets
  the device).
- Two concurrent client connections multiplex correctly (interleaved
  requests get matching response ids).
- Progress push frames arrive during a slow FakeDriver provision
  (FakeClock-advanced).
- Partial/torn JSON lines: bytes arriving split mid-frame parse correctly;
  garbage line → error response, connection survives.
- Stale socket file recovery; second daemon refuses to start while first
  lives.
- Graceful stop releases held leases and flushes state.

## Watch out

- Never trust frame boundaries — buffer and split on `\n` yourself.
- requesterId ties to one-lease-per-agent: same requesterId on a NEW
  connection while holding a lease → rejected (the agent restarted its CLI
  without killing the old holder — surface a clear error naming the held
  lease).
- All timers via Clock port; all fs via Filesystem port (socket is exempt —
  `node:net` is the transport itself; wrap only if a fake proves necessary).

## Acceptance criteria

- [ ] Connection-close-releases-lease proven by test (the core semantic).
- [ ] Framing robust to torn writes; multiplexing correct.
- [ ] Daemon start/stop lifecycle + stale socket recovery tested.
- [ ] `pnpm check` green.
