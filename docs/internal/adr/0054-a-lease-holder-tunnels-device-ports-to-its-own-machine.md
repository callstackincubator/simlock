# 0054. A lease holder tunnels device ports to its own machine

- **Status:** Proposed
- **Date:** 2026-10-30
- **Issue:** [#1110](https://github.com/callstackincubator/simlock/issues/1110)
- **Narrows:** [ADR 0005](0005-gateway-and-worker-modes.md) Non-goals ("A
  byte-heavy data plane": port forwarding is not proxied) for TCP tunnels
  between a lease's Android device and its holder's machine. ADR 0005
  Decisions 1 and 8 stand: the gateway's port stays the only inbound port,
  and no worker address reaches a client.
- **Builds on:** [ADR 0028](0028-the-uplink-carries-byte-channels-and-small-messages-go-first.md)
  (byte channels), [ADR 0049](0049-a-lease-holder-watches-and-drives-its-devices-screen.md)
  (a module owns a lease WebSocket, relayed to the worker).

## Context

An agent on another machine runs `adb reverse tcp:5173 tcp:5173` through
`device.exec`, and the device reaches port 5173 on the worker, not the
agent's dev server (#1100). Every device test of a local build has to move
to the worker.

ADR 0005 left port forwarding out because the gateway proxied requests,
not sessions. ADR 0028 since gave the uplink byte channels built for live
streams, and ADR 0049 streams screens and input through the gateway on a
lease WebSocket. The transport exists; only the decision to carry ports on
it is missing.

Two limits shape it. The uplink opens at most 64 channels per side at once,
for every lease on a worker, and a dev server page opens dozens of
connections. And adb can do both directions without a listening worker
port: `adb reverse tcp:<device> tcp:<worker loopback port>` makes a device
connection reach a worker listener, and adb's host protocol
(`host:transport:<serial>`, then `tcp:<port>`) opens one stream to a device
port with no `adb forward` rule (both checked with adb 37.0.0 on
2026-10-30).

```mermaid
flowchart LR
  subgraph Caller machine
    DS[dev server :5173]
    T[simlock tunnel]
  end
  subgraph Gateway
    G[lease WebSocket /tunnel]
  end
  subgraph Worker
    M[tunnel module] --> L[loopback listener]
    M --> A[adb]
  end
  D[Android device]
  T <-->|one WebSocket| G
  G <-->|one uplink channel| M
  D -->|adb reverse tcp:5173| L
  M -->|host protocol tcp:p| D
  T --> DS
```

## Decision

1. A new optional module, `tunnel`, owns `GET /v1/leases/{id}/tunnel`, a
   WebSocket on a lone worker and on a gateway, which relays it to the
   lease's worker as the input socket is relayed: frames wrapped
   `[len u32][tag u8][payload]`, a worker heartbeat every 5 s, and close
   codes carried in a close frame. It is on only under
   `capabilities.tunnel.enabled`, off by default on every role. Only the
   lease's holder and operators reach it.
2. One socket carries every tunnel and every TCP connection of one
   `simlock tunnel` run, so a run costs one uplink channel. The client
   names its tunnels first (`reverse` or `forward`, a device port 1024 to
   65535); the worker opens all of them or none and answers which. At most
   8 tunnels per lease at once.
3. Inside the socket each TCP connection has an id. Binary messages open,
   carry data for, give credit to, half-close and reset a connection; a
   message carries at most 64 KiB of data, each direction of a connection
   has a 256 KiB window, and at most 256 connections are open at once.
   A slow reader stops only its own connection.
4. `reverse` on Android: the worker listens on a loopback port it picks and
   runs `adb reverse --no-rebind tcp:<device port> tcp:<that port>`; a
   device port already reversed is refused. Each accepted connection is
   announced to the client, which connects to its own loopback port.
   `forward` on Android: the client listens on its own loopback port; each
   connection is announced to the worker, which opens the device port
   through adb's host protocol. The caller side touches loopback only.
5. The module reaches adb only through a port the daemon gives it, as the
   stream and input modules reach screens and input; the Android driver
   implements it for emulators and enrolled phones. Other devices are
   refused.
6. A tunnel lives while its socket does. When the socket closes, the
   worker removes its `reverse` rules and closes its listeners and
   connections. When the lease ends, every socket of it closes. Android
   reclaim removes every `reverse` rule on the device, the tunnel's and any
   an agent made through `exec`, and every `forward` rule the adb server
   holds for that device's serial. It never runs `forward --remove-all`:
   forward rules live in the server, which other devices and tools share.
7. The socket's messages are the module's, not a contract shape: no
   protocol bump.
8. `simlock tunnel` opens the socket with `ws`, through a port adapter only
   that command loads: Node 22's built-in WebSocket client cannot send the
   `Authorization` header the daemons require. Every other CLI command and
   the MCP server still never load `ws`.

```mermaid
sequenceDiagram
  participant C as simlock tunnel (caller)
  participant G as Gateway
  participant W as Worker tunnel module
  participant D as Device
  C->>G: WebSocket /v1/leases/{id}/tunnel (agent token)
  G->>W: two-way relay, one channel
  C->>W: tunnels: reverse 5173
  W->>D: adb reverse --no-rebind tcp:5173 tcp:<loopback>
  alt port already reversed
    W-->>C: refused (port in use), socket closes
  else
    W-->>C: ready
    D->>W: connection on tcp:5173
    W->>C: open conn 1
    C->>C: connect localhost:5173
    C-->>W: data / credit / end
  end
  Note over C,W: socket closes → rules removed; lease ends → 4001
```

## Consequences

- An agent anywhere tests a local build on a leased Android device with one
  command, through the gateway's one port.
- An operator who turns the module on lets lease holders move arbitrary TCP
  bytes between their machine and the device. The device still reaches only
  the holder's loopback, and the holder only the device's ports.
- `dataPlane` on the lease stays reserved; tunnels are a module route, not
  a lease field.
- Reclaim gains a step on Android, and rules made by hand no longer leak
  into the next lease.
- A third file imports `ws`, loaded by one CLI command only.
- iOS simulators are not covered: their `reverse` would be a port on the
  worker shared by every lease, the host-port problem #162 owns.

## Alternatives considered

- **One WebSocket per TCP connection.** Rejected: a busy dev server would
  use up the worker's 64 uplink channels and stall every other relay.
- **A direct path from caller to worker.** Rejected: it needs an inbound
  port on every worker, against ADR 0005 Decision 1.
- **`adb forward` rules on the worker.** Rejected: each would hold a worker
  port; the host protocol reaches the device port with none.
- **Replace an existing `reverse` rule.** Rejected: it would silently break
  a rule the agent set up itself.
