# Tunnel

Does: lets a lease's holder (or an operator) reverse device ports of its Android device or iOS simulator to its own machine, forward its own loopback ports to the device's, or reach an Android emulator's adb port (the `emulator` kind), over `WS /v1/leases/{id}/tunnel`, on a lone worker or through a gateway.

## Rules

Boundaries:

- The module imports nothing from http, gateway, drivers, daemon or leasing; `ctx.deviceTcp` is the only door to a device. No dependency rule holds this.
- The module never checks an owner; the HTTP layer does. The worker's own registry decides whether the lease and its device still exist.
- Tags, limits and the refusal close code come from `src/contract/tunnel-frames.ts`, which the caller's side shares.

A session:

- The first frame must be `HELLO`, and it is checked whole before anything is set on the device.
- The tunnel limit counts every socket of one lease, not one socket.
- A failed reverse removes the tunnels set before it, then refuses with the driver's `DeviceTcpError` code.
- A refusal sends `REFUSED` with the whole message, then closes; only the close reason is cut, because `ws` throws on a long one.
- Wire input never throws: a bad frame is `BAD_REQUEST` and a close, and the daemon goes on.
- The worker opens odd connection ids and the caller even ones, each rising. A frame for an id that was never opened is `BAD_REQUEST`; one for a connection already closed is ignored.
- A caller's `OPEN` is trusted only when it names a forward tunnel of this socket, or the emulator port when `HELLO` named it.
- A caller's connection exists from its `OPEN`: `pendingStream` holds its `DATA`, `END` and close in order until the device connect settles. A failed connect is `RESET`, not a refusal.
- A connection reads from its device only while the caller's window allows, so a slow reader stops its own connection and no other. A device stream that fails resets its own connection.
- An emulator port is named by what it serves (`adb`), never by number, and needs `ctx.deviceTcp.supportsEmulatorPort`.

Ends:

- The socket closing, the lease ending (`beforeDeviceReclaim`) and a drain (`beforeDrain`) close the session's connections and remove its rules. Each session finishes once.
- The hook returns only when the removals are done, a removal the socket's close began included. One removal waits at most `REMOVAL_TIMEOUT_MS` (`sessions.ts`).
- On an emulator, a lease-end signal that is aborted, or aborts between removals, skips the rest: reclaim removes them.
- On a phone the removals run anyway, because its reclaim removes no rules.
- A reverse whose `holdsDeviceRule` is false (an iOS simulator's: local listeners and no rule on the device) is closed anyway, because no reclaim will.
- A removal that fails is logged at `warn`; the driver keeps the loopback port reserved until reclaim, and on a phone until no rule there points to it.

Through a gateway:

- The gateway's `socket.open` relays to the worker's `tunnel` target with the worker's lease id; the worker's `relayTwoWay` attaches a `channelSocket` to a session as a local socket would. The bridge is [modules](../modules/AGENTS.md)'s `createGatewayChannelLink`.
- A holder frame longer than `MAX_TUNNEL_MESSAGE_BYTES` (`limits.ts`) would break the channel for the whole lease, so the gateway refuses it itself, as the worker refuses a bad frame.
- A worker closes a socket only with a code `closeOf` (`modules/relay-channel.ts`) lets through; any other reaches the holder as "the worker stopped answering".
