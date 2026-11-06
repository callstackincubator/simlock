# Daemon

Does: one process per data directory — composes a worker or a gateway and serves the contract on a unix socket.
Flows: [startup](../../docs/internal/flows/startup.md), [device.exec](../../docs/internal/flows/device-exec.md), [gateway](../gateway/AGENTS.md).

## Rules

Dispatch:

- One `Dispatcher` instance serves the socket, the uplink and HTTP; HTTP calls `DaemonServer.dispatch` in process.
- Handlers never see raw input and never check roles: `runDispatch` (`dispatch.ts`) does both first.
- The `authorize` hook lets an unknown lease id pass, so the handler answers `UNKNOWN_LEASE`, not `FORBIDDEN`.
- Lists filter in the handler, not in `authorize`: an `agent`'s `lease.list`, and `status.get`'s `leases` and `waiting`, hold only what its principal owns.

Start and stop:

- The socket claim comes before any write to `admin.token` and before converge. A daemon that lost the claim never touches `admin.token`.
- `admin.token` is removed on stop before the endpoint is released, so an old shutdown cannot remove a replacement's credential.
- A worker with real drivers takes the worker lock (`ports/worker-lock.ts`) before `discoverDrivers`, makes sure it holds it after the socket claim, and releases it after the drivers are disposed and on a failed start; substituted drivers and gateways never take it.
- On a worker, no request but `hello`, `status.get`, `daemon.stop` and `daemon.update` with `query` runs before converge ends. A gateway's dispatcher never parks.
- `daemon.stop` is handled by the server, before the version and stopping gates. `daemon.update` skips only the version gate.
- `daemon.started` is emitted only after converge, and never after `daemon.stopping`. A stop during converge arms nothing.
- A failed claim or `admin.token` write: `start` disposes what the stop does, without `daemon.stopping` or the `admin.token` removal, then rejects. A stop already running is the one teardown instead: `start` rejects at once, and `startDaemon` waits for the stop before it rejects.
- `DaemonAlreadyRunningError` skips `settle` and `dispose`: the live daemon may share the drivers' adb server. The entry then exits at once (`process.exit`), since a start that lost the claim keeps its drivers' children.
- A bind failure of the HTTP listener fails the start and stops the daemon (`http-start-failed`).
- `daemon.stop` releases nothing; leases persist with their deadlines.
- `dispose` stops the event history after the drivers are disposed, and closes `state.db` last.
- A history file that fails costs only history. A start the history refuses (a newer stored projection version, a failed migration) stops the daemon (`history-refused`).
- A daemon works in its own role's data directory. Its one look outside is the update's `socketHeld` probe of the other role's socket (`composition-support.ts`).

Connections:

- Role and principal are fixed at `hello` for the connection's life. The uplink connection is `admin` by acceptance; otherwise admin comes only from a credential at `hello`, never from the socket itself.
- No protocol overlap leaves the connection open: every request but `daemon.stop` and `daemon.update` gets `PROTOCOL_VERSION_UNSUPPORTED`.
- A closed connection only silences its pushes; the request, the lease and a running command go on.
- `lease-lost` skips the connection that asked for that release.
- On Windows the endpoint is a named pipe: none of the socket-file steps run, and a live one fails the bind with `address-in-use`.

Update:

- A gateway's update holds no leases, so it never waits.
- `query` starts nothing. A call during an update follows it; `force` on `waiting` installs now.
- `DaemonServer.start` calls `readResultFile()` after convergence and before health is `running`, so a `running` daemon already shows the failure. `announceResultFile()` emits `daemon.update-failed` once the daemon serves, so a parked `events.subscribe` receives it.

Relays (worker side):

- `relay.request` runs only on the uplink connection.
- A `twoWay` relay runs no body cut-off. Its target answers a refusal before touching the pipe, or a 2xx with no body and then uses the pipe; the call answers once both directions have ended. The silence bound is the gateway's.
- `files` is the one relay target the core names: the lease files of a worker, served for a gateway (ADR 0067 §7). A module cannot take the name.
- `GatewayUplink` retries forever.

## Security model

Cooperative identity, not a hostile-process boundary.

- Every socket peer is the same OS user; file modes are the real boundary. An existing data directory is never chmod'ed; the daemon warns when group or others can reach it. On Windows no directory guards the pipe: see [ports](../ports/AGENTS.md).
- A `hello.principal` is a claim. Ownership checks stop accidents, not attacks.
- A worker that joins a fleet grants its gateway `admin` over itself, and must not be able to crash, stall or corrupt it: see [gateway](../gateway/AGENTS.md#rules).
- An `agent` token is shell access to the worker: `device.exec` runs host tools as the daemon's user, with only the keys `execBaseEnvironment` (`exec-env.ts`) keeps plus the command's own.
