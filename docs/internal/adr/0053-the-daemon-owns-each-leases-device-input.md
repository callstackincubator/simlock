# 0053. The daemon owns each lease's device input, and `device.rotate` uses it

- **Status:** Proposed
- **Date:** 2026-10-30
- **Issue:** [#1105](https://github.com/callstackincubator/simlock/issues/1105)
- **Narrows:** [ADR 0049](0049-a-lease-holder-watches-and-drives-its-devices-screen.md)
  §2 (the optional `input` module owns a lease's device input) and
  [ADR 0052](0052-an-ios-simulator-takes-serve-sims-rotation.md) §1 (rotation
  is an input-socket message only).

## Context

ADR 0052 lets an iOS simulator take serve-sim's rotation, but only as `0x07`
on the lease's input WebSocket. That socket belongs to the optional `input`
module, which is off unless `capabilities.input.enabled` is on, on the
worker and on the gateway. An agent using the CLI, MCP, plain HTTP or
agent-device cannot send it (#1098).

The one device input per lease, an iOS input helper process
(`simlock-screen-capture <udid> --input`), is opened and shared inside the
input module today (`src/input/sessions.ts`): the first socket opens it,
the last one leaving closes it, and lease reclaim closes it through the
module's `beforeDeviceReclaim` hook. A rotation that does not go through a
socket needs the same helper, whether or not the module is loaded. Two
helpers on one simulator at once are untested, and nothing needs them.

```mermaid
flowchart LR
  subgraph Before
    S1[input socket] --> M1[input module: per-lease helper] --> H1[iOS helper]
  end
  subgraph After
    S2[input socket] --> M2[input module]
    M2 --> D2[daemon: per-lease device input]
    R2[device.rotate] --> D2
    D2 --> H2[iOS helper]
  end
```

## Decision

1. The daemon keeps one device input per lease, opened through the driver
   catalog on first use and shared by every user. Users are the input
   module's sockets and an in-flight `device.rotate`. It closes when no
   socket holds it and no rotate is in flight, and at lease reclaim.
2. The input module takes the lease's device input from the daemon through
   its context instead of opening its own. Its socket behaviour (limits,
   close codes, `0x82`, failure handling) does not change.
3. `device.rotate {leaseId, orientation}` is a core contract operation, role
   `agent`, authorized as `device.exec` is. It is always on, independent of
   `capabilities.input.enabled`. On an iOS simulator lease it takes the
   lease's device input, sends `0x07 {orientation}` and answers
   `{leaseId, orientation}` once the message is written, then lets the input
   go. It reports no new orientation and does not wait for the screen.
4. Any other lease is refused with `ROTATION_UNSUPPORTED` before a device
   input is opened. A device input that cannot open is `INPUT_UNAVAILABLE`.
5. A gateway forwards `device.rotate` to the lease's worker, as it forwards
   `device.exec`.

```mermaid
sequenceDiagram
  participant C as Caller (CLI, MCP, HTTP, front)
  participant G as Gateway
  participant W as Worker daemon
  participant H as iOS helper
  C->>G: device.rotate {leaseId, landscape_left}
  G->>W: device.rotate {workerLeaseId, landscape_left}
  alt not an iOS simulator
    W-->>C: ROTATION_UNSUPPORTED
  else helper cannot open
    W-->>C: INPUT_UNAVAILABLE
  else
    W->>H: 0x07 {orientation}
    W-->>C: {leaseId, orientation}
  end
```

## Consequences

- An agent rotates an iOS simulator from any surface with the input module
  off.
- The daemon gains a small per-lease registry it did not have; the input
  module loses one. Lease reclaim closes the device input in the daemon, not
  only through the module's hook.
- A rotate with no socket open pays the helper's start each time (bounded at
  10 s).
- The contract grows one operation and two error codes, and the protocol is
  bumped.

## Alternatives considered

- **A rotate route inside the input module, gated by
  `capabilities.input.enabled`.** Rejected: modules add HTTP routes, not
  contract operations, so the CLI and MCP could not reach it, and the
  setting is off by default.
- **A second helper for each rotate, outside the module.** Rejected: two
  helpers on one simulator at once are untested, and sharing costs little.
- **Keep a rotate's helper until the lease ends.** Rejected: an idle process
  per rotated lease for a call that is rare.
