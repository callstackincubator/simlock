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
- One capture per device is shared by its viewers, whichever path they asked by: the first viewer to pass the checks opens it, the others join it, also while it starts (`broadcast.ts`, `worker-link.ts`). A joiner's body is the current meta frame, the current parameter sets, then frames from the next key frame, so it can wait for its picture until the capture sends one; MJPEG waits for nothing.
- A viewer that stops reading skips frames and slows nobody: past `MAX_VIEWER_QUEUE_BYTES` it drops its queued pictures and skips to the next key frame. Meta frames, parameter sets and the lease-end frame are never dropped, and a slow viewer is never cut off.
- A capture that fails to start refuses every viewer waiting for it the same way, and one that fails mid-stream errors every body; the next viewer starts a fresh one.
- Every end closes the capture once: the last viewer leaves (one that leaves while others watch closes nothing), the capture ends or errors, the silence bound passes, the lease ends, the device stops. A viewer's `expiresAt` ends only that viewer.
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
3. A device with a capture already running or starting is joined. Otherwise the link registers a capture slot for the device, then opens the screen through the driver catalog the daemon passed in.
4. It waits for the meta frame within the start bound, then reads the slot again: a device that stopped meanwhile is refused for every viewer waiting.
5. Each viewer is answered with the picture's description in headers and its own queue of the capture's frames as the body, meta first.

Through a gateway:

1. The gateway's link refuses a non-operator on a device path and a worker that is not in the fleet.
2. It relays the request to the worker's `stream` relay target, by device id or by the worker's own lease id.
3. The worker serves it through the same link, slots and checks as a local request.
4. The gateway checks the answer's headers and passes the body on; its relay bounds the body by inactivity, and by the caller's `expiresAt`.
