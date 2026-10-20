# Stream

Does: serves a leased device's live screen at `GET /v1/stream/leases/{leaseId}`, on a worker and through a gateway.
Entry: `index.ts` → `streamModule`, an optional module (ADR 0030): `worker.ts` `createWorker`,
`gateway.ts` `createGateway`, loaded by the module host only when turned on.
Uses: core (`ScreenFeed`, frame tags, registry records), modules (the context and hook types), ports.
Never imports: http, gateway, drivers, daemon, leasing, `fs`, `child_process`. Imported by: `module-registry` only.
Off unless `capabilities.stream.enabled` (false). Off: nothing loaded, and the `stream` capability reads `off`.

## Files

| File                      | Role                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `definition.ts`           | `streamModule`: name `stream`, config section, the two loaders                  |
| `worker.ts`, `gateway.ts` | The module's two sides, built from the host's context                           |
| `create.ts`               | The two factories; the `stream` capability read from each driver's availability |
| `worker-link.ts`          | Worker: lease check, open through the driver, register, re-check after frame 1  |
| `gateway-link.ts`         | Gateway: fleet ownership, relay to the holding worker, refusal and header check |
| `feed.ts`                 | `readScreenFeed`: meta frame first, start and silence bounds, close on any end  |
| `framing.ts`              | `MetaFrameScanner`, `checkedMeta`: codec and size a picture may claim           |
| `captures.ts`             | Captures per lease; the lease-end participant that stops them                   |
| `service.ts`              | One request either door: method, refusal body, response headers, log line       |
| `mounts.ts`               | The HTTP mount and the relay target                                             |
| `refusal.ts`              | `StreamRefusalError`, each refusal's status and code, a relayed refusal checked |
| `caller.ts`               | Who asks                                                                        |
| `test-fixtures.ts`        | `TestRegistry`, `ScriptedFeed` for tests                                        |

## How it works

Worker — `worker-link.ts` `createWorkerStreamLink`:

1. Lease from the registry snapshot. Agent: its requester (relayed) or principal must hold it.
   Unknown and not yours both answer 404 `UNKNOWN_LEASE`; nothing is opened first.
2. `captures.begin(leaseId)` — registered before the capture starts.
3. `ctx.screens.openScreen(platform, device, settings)` (the daemon passes its `DriverCatalog`) → the driver's `ScreenFeed`.
   `ScreenNotSupportedError` → 415 `STREAM_NOT_SUPPORTED`; anything else → 503 `STREAM_UNAVAILABLE`.
4. `readScreenFeed`: the meta frame within the start bound, or 503 and close.
5. Lease re-read: gone, re-granted, or its slot stopped → close, 404.
6. 200; headers `simlock-stream-{codec,fps,width,height}`; body = the frames, meta first.

Ends — each closes the capture once (`closedOnce`): the viewer cancels or aborts; the capture
ends or errors; no byte within the silence bound; the lease ends (the `beforeDeviceReclaim` hook, `createStreamLeaseEnd` →
`captures.stop`, which waits for every close, bounded by the driver and by leasing's signal).

Gateway — `gateway-link.ts`: the fleet lease index names owner, worker and the worker's lease
id. Not the owner (agent) → 404. Relays `GET /stream/leases/<worker lease>` as target `stream`
with tenant `<requesterPrefix><requesterId>` from the index, never from the caller. A refusal
body is read to 16 KiB; its code and message are forwarded only if the code matches
`^[A-Z][A-Z0-9_]{0,63}$`, else the code becomes `STREAM_UNAVAILABLE`. The worker's 4xx or 5xx
status is kept either way; a 2xx without a picture → 502. Headers go through `checkedMeta`.
The body is relayed unread; the gateway's relay bounds it by inactivity, not by a deadline.

Capability `stream`: `available`, with no reason, when any driver can capture (a platform that
cannot says why in its 503); `unavailable` when none can, with each platform's reason.

## State and timers

Memory only: running captures per lease (`captures.ts`).

| What                         | Default              | Key                                                                                              |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| First frame                  | 30 s                 | `DEFAULT_START_MS`                                                                               |
| Silence between frames       | 30 s                 | `DEFAULT_SILENCE_MS`                                                                             |
| Frame ceiling (envelope)     | 8 MiB                | `MAX_FRAME_BYTES`                                                                                |
| fps / longest side / bitrate | 30 / 720 / 1500 kbps | `capabilities.stream.fps`, `capabilities.stream.maxDimension`, `capabilities.stream.bitrateKbps` |

## Rules

- No platform name here: a driver offers `screenCapture` or not (`core/screen.ts`).
- Ownership before any work; unknown and not-yours answer the same.
- A capture is registered before it starts and the lease is re-read after its first frame,
  so a capture never outlives its lease (`worker-link.test.ts`).
- A gateway never parses a video byte and never takes a caller's word for the requester.
- No business events: watching changes no lease or device. Each open and refusal is logged.

## Known gaps

- **View only.** No touch or key input.
- **Each viewer is its own capture.** Two tabs on one device run two captures.
- **A frame skipped by a slow viewer is not dropped, it is waited for.** A viewer that stops
  reading slows the capture behind it to its pace.
