# Tunnel

Does: lets a lease's holder (or an operator) reverse device ports of its Android device to its own machine over `WS /v1/leases/{id}/tunnel`, on a lone worker.
Entry: `index.ts` -> `tunnelModule`, an optional module (ADR 0054): `worker.ts` `createWorker`, loaded by the module host only when turned on.
Uses: contract (the tunnel frame codec), core (`DeviceReverse`, `DeviceTcpError`), modules (the context, socket types), ports (`LeaseSocket`).
Never imports: http, gateway, drivers, daemon, leasing, `fs`, `child_process`. Imported by: `module-registry` only.
Off unless `capabilities.tunnel.enabled` (false). Off: nothing loaded, and the `tunnel` capability reads `off`.

## Files

| File            | Role                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| `definition.ts` | `tunnelModule`: name `tunnel`, empty config section, `http` route data, the worker loader |
| `worker.ts`     | The worker side from the host's context: capability, hooks, lease route (426), socket     |
| `sessions.ts`   | One session per socket: HELLO, rules, connections, window and credit, lease end, drain    |
| `refusal.ts`    | The 404 `UNKNOWN_LEASE` and 426 bodies                                                    |

## How it works

The HTTP layer resolves the lease for the caller, then `socket.open` finds the lease and its device in the worker's registry (404 `UNKNOWN_LEASE` when gone) and attaches a session to the upgraded socket.

1. The first frame must be `HELLO`. It is checked whole: bad port, more than 8 tunnels per lease (counted across sockets), `forward` (not available yet), a platform whose driver has no `deviceTcp` (`supports`). A refusal sends `REFUSED {code, message}` and closes 4003 (the close reason is cut to 123 bytes, the message is whole).
2. Each reverse tunnel is `ctx.deviceTcp.reverse`. A failure removes the tunnels set before it and refuses with the driver's `DeviceTcpError` code (`TUNNEL_PORT_IN_USE`, `TUNNEL_FAILED`), else `TUNNEL_FAILED`. Then `READY`.
3. A device connection is `OPEN` with the next odd id; its bytes go out as `DATA` only while the caller's window allows, and the worker grants `CREDIT` as it writes to the device. `END` half-closes one direction; a connection ends when both have. A 257th open connection is closed at once.
4. A bad frame (a `CREDIT` that is not 4 bytes, a `DATA` of 0 or over 65536 bytes included) is `BAD_REQUEST`, close 4003, never a throw; a frame for a connection already closed is ignored; a device stream that fails resets its own connection.
5. The socket closing, the lease ending (`beforeDeviceReclaim`, close 4001 with the reason) and a drain (`beforeDrain`, close 1001) close the session's connections and remove its rules, the hook returning when they are done (10 s per removal); a signal that is aborted, or aborts between removals, skips the rest and reclaim does them.

## Rules

- The module never checks an owner; the HTTP layer does.
- The module never imports a driver; `ctx.deviceTcp` is the only door to a device.
- A removal that fails is logged at `warn`; the driver keeps the loopback port reserved until reclaim.
