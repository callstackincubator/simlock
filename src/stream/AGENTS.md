# Stream

Does: serves a running device's live screen to operators at `GET /v1/stream/workers/{workerId}/devices/{deviceId}`, and a lease's screen to its holder or an operator at `GET /v1/leases/{id}/stream`, on a worker and through a gateway.

## Rules

Who may watch:

- The caller and the device are checked before any work; an agent and an unknown device get the same answer, and so does a path that names no stream.
- A device path is for operators only. A lease path checks no owner here: the HTTP layer has already resolved the lease for the caller (owner or operator).
- The relay door serves whatever the tenant: the gateway has already refused a non-operator on a device path and a non-owner on a lease path.
- A gateway never takes a caller's word for the tenant: it builds it from its own `requesterPrefix` and the principal.

Captures:

- No platform name here: a driver offers `screenCapture` or not (`core/screen.ts`).
- A capture is registered before it starts and its slot is read again after its first frame, so a capture never outlives its device's running state (`worker-link.test.ts`, `create.test.ts`).
- Every end closes the capture once: the viewer leaves, the capture ends or errors, the silence bound passes, the lease ends, the device stops.
- The lease end (`beforeDeviceReclaim`) waits for every close before the device is reclaimed, bounded by the driver and by leasing's signal.
- A device that stops with no lease end runs no reclaim hook, so the device events in `create.ts` stop its captures.
- A lease granted while streaming ends nothing.
- A stop with a lease-end reason writes one last frame holding the reason before the body ends. Every other stop, and a viewer that leaves, ends with no frame.
- `device.absence-detected` on a leased device passes `device-lost` itself: the registry commits that lease end and then emits, so this stop runs before the lease-end participants, and the lease end after it finds no capture and adds no second frame.
- The console opens the stream again only after a started stream ends with no reason, never after a failure or a refusal (`ui/src/state/screen.ts`).

Gateway:

- A gateway never parses a video byte: it reads the headers, checks them with `checkedMeta` as a worker checks a meta frame, and relays the body unread.
- A worker's refusal is a claim: its status is kept, but its code is forwarded only when it has the shape of ours (`relayedRefusal`, `refusal.ts`). A success without a picture is the gateway's own failure.
- A worker names a lease by its own id; the gateway puts the caller's lease id back into an unknown-lease answer.

Deadline (ADR 0033 §6):

- A stream opened by an identity with `expiresAt` (a sign-in proxy's) ends at that time, on the host that checked the identity. A token or the local socket has none and is unbounded.
- The relay door sets no deadline: the gateway has already bounded the stream.

Other:

- No business events: watching changes no lease or device. Each open and refusal is logged.

## Flow: a screen stream

On a worker:

1. The HTTP layer hands the module a device path (the mount) or a resolved lease (the lease route).
2. The worker link checks the caller, the worker id and the device's state, or finds the lease's device in the worker's own registry.
3. It registers a capture slot for the device, then opens the screen through the driver catalog the daemon passed in.
4. It waits for the meta frame within the start bound, then reads the slot again: a device that stopped meanwhile is refused.
5. It answers with the picture's description in headers and the frames as the body, meta first.

Through a gateway:

1. The gateway's link refuses a non-operator on a device path and a worker that is not in the fleet.
2. It relays the request to the worker's `stream` relay target, by device id or by the worker's own lease id.
3. The worker serves it through the same link, slots and checks as a local request.
4. The gateway checks the answer's headers and passes the body on; its relay bounds the body by inactivity, and by the caller's `expiresAt`.

## Known gaps

- **Each viewer is its own capture.** Two tabs on one device run two captures.
- **A frame skipped by a slow viewer is not dropped, it is waited for.** A viewer that stops reading slows the capture behind it to its pace.
