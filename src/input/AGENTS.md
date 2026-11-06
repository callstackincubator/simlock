# Input

Does: lets a lease's holder (or an operator) send taps, keys, buttons and rotations to its device over `WS /v1/leases/{id}/input`, on a worker and through a gateway, in expo serve-sim's messages.

## Rules

- Nothing here imports `ws`: a socket is a `LeaseSocket`, whichever door the client came in by.
- Lease ownership is checked by the HTTP layer only. The worker's own registry decides whether the lease still exists: it can end between that check and the upgrade.
- A lease has one device input, the daemon's (`ctx.inputs.leaseInput`), shared by every socket of the lease and by `device.rotate`. The session holds it once and gives it back when the last socket leaves, the lease ends, the daemon drains or the input fails.
- An unavailable device input is not an error: the socket is admitted, gets `UNAVAILABLE_INPUT_CONFIG` and its messages are dropped.
- A client message that `parseClientMessage` (core) refuses is dropped and the socket stays. The device input decides what a valid message does.
- A worker closes a socket only with a code `closeOf` (`modules/relay-channel.ts`) lets through; any other code reaches a gateway's client as "the worker stopped answering".
- `ws` throws on a close reason over its byte limit, and `sessions.ts` cuts nothing: it closes only with fixed texts and the lease-end reason. A reason a peer or a driver chose goes through `closeReason` (core) first.
- The caps on sockets per lease and on retries after a failed open are `MAX_SOCKETS_PER_LEASE` and `FAILED_OPEN_MEMORY_MS` (`sessions.ts`); both close the socket as a failure, not as a refusal before the upgrade.
- The gateway side holds no rule of its own: `gateway-link.ts` gives `createGatewayChannelLink` its path, frame bound and refusal text, and [modules](../modules/AGENTS.md) owns the bridge.

## Flow: a lease's input socket

On a worker:

1. The HTTP layer resolves the lease for the caller, then asks the module's `socket.open`, which answers a refusal or an accept.
2. The upgrade router hands the accept the upgraded socket, and the worker link attaches it to the lease's session.
3. The session takes the lease's device input from the daemon and, once it is open, tells the socket it is admitted and sends the screen's config; later config changes go to every admitted socket.
4. Client messages go through core's parser to the device input.
5. The lease end (`beforeDeviceReclaim`) and a drain (`beforeDrain`) close every socket of the session with their own codes and release the device input.

Through a gateway:

1. The same `open` on the gateway calls `relayTwoWay` to the worker's `input` target, naming the worker's lease id. A refusal here is answered before the upgrade.
2. The worker's `relayTwoWay` finds the lease and attaches a `channelSocket` to the same session a local socket would join.
3. The gateway's bridge passes client frames to the channel and channel frames to the client; the worker's close frame closes the client.
4. If the handshake is refused after the relay opened, the router calls the accept's `abandon`, which ends the relay.
5. When the gateway sees the lease go, it waits a short time for the worker's close frame, which carries the reason, before it closes the client itself.
