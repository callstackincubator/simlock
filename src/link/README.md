# Link

Does: wraps one uplink transport connection; carries text messages and byte channels, small messages first.
Entry: `index.ts` → `createLink(transport, { end, clock, logger, generateId? })` → `LinkConnection`.
Uses: the types of ports (`UplinkTransportConnection`, `IpcConnection`, `Clock`, `Logger`). Never imports:
anything else, nor (outside its test helpers) any Node module or package (lint: `link-is-portable`, `link-imports-port-types-only`),
so it runs in a browser or React Native. Channel ids: `generateId`, else `crypto.randomUUID`, else
`getRandomValues`, else an error naming `generateId`; an id outside 1–32 of `[A-Za-z0-9-]` is refused.
Imported by: daemon (`daemon/gateway-uplink.ts` wraps with `end: "worker"`; `daemon/server.ts`
accepts channels, `daemon/relay.ts` uses them), gateway (`gateway/service.ts` wraps with `end: "gateway"`;
`gateway/relay.ts` opens channels), simlock-client (`openChannel` on a linked connection).

## Files

| File                | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `index.ts`          | `createLink`, the `Link` connection: numbers, opens, dispatch, rule checks |
| `channel.ts`        | One channel: streams, credit, stop, reset, timers; `LinkChannelError`      |
| `envelope.ts`       | Binary envelope encode/parse; size constants                               |
| `scheduler.ts`      | Two send lanes per connection                                              |
| `testing.ts`        | `linkPair` over an in-memory pair, raw envelope helpers                    |
| `test-websocket.ts` | A real WebSocket pair for tests                                            |

## How it works

`LinkConnection` is an `IpcConnection` (`write`, `onData`, `onClose`, `onError`,
`close`) plus `openChannel({ signal })` and `acceptChannel(id)`.

1. **Messages** — `write(text)` goes in the priority lane. Text received before
   any `onData` listener is held, then handed to the first one.
2. **Open** — `openChannel` sends `OPEN` with a new id from `generateId` (priority lane).
   The worker numbers odd from 1, the gateway even from 2. Numbers are 32-bit
   and never reused on a connection.
3. **Name it** — the user puts `channel.id` in a message (e.g. `relay.request`).
   `OPEN` always leaves before that message.
4. **Accept** — the peer calls `acceptChannel(id)`. It throws for an id never
   opened, already accepted, or ended. Not accepted in 30 s → reset `not-accepted`.
5. **Bytes** — `writable` bytes leave as `DATA` of at most 64 KiB (bulk lane).
   Each side may send 4 MiB before any `CREDIT`; past that, only what the peer granted.
6. **Credit** — the reader grants `CREDIT` as its user reads off `readable`.
   `credit` and `whenCredit()` let a writer skip data instead of waiting.
7. **End** — closing `writable` sends `END` for that direction. Cancelling
   `readable` sends `STOP`; the peer's writer errors `stopped` and answers `END`.
   `abort(reason)` sends `RESET` and ends both directions.
8. **Done** — a channel frees its slot once this side's `END`/`RESET` is handed
   to the transport and the peer's `END`/`RESET` has arrived.
9. **Close** — a closed transport errors every channel and open waiter with `closed`.

Lanes (`Scheduler`): text, `OPEN`, `STOP`, `CREDIT`, `RESET` are priority;
`DATA`, `END` are bulk. Bulk goes to the socket only while under 256 KiB is unsent;
the transport's `onSent` wakes it. Channels take turns, one message each.
Priority goes first, but bulk sends one message per 64 KiB of priority.

## Limits and timers

| What                           | Value                                                                    | Where                   |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------- |
| Channels open per side         | 64; the 65th `openChannel` waits on its signal                           | `index.ts` `OPEN_LIMIT` |
| `DATA` payload                 | 64 KiB                                                                   | `MAX_DATA_BYTES`        |
| Window per channel, each way   | 4 MiB                                                                    | `CHANNEL_WINDOW`        |
| Unsent bytes before bulk waits | 256 KiB                                                                  | `scheduler.ts`          |
| Bulk share                     | 1 message per 64 KiB of priority                                         | `scheduler.ts`          |
| Accept wait                    | 30 s → `not-accepted`                                                    | `channel.ts`            |
| Stall wait                     | 60 s of a waiting write while the peer holds every byte sent → `stalled` | `channel.ts`            |
| Channel id                     | `[A-Za-z0-9-]{1,32}`                                                     | `envelope.ts`           |

None of these is configurable.

## Rules

- A channel fails only by: peer abort, peer rule break, accept timeout, stall,
  or connection close. `LinkChannelError.reason` says which. The connection stays up.
- A rule break drops the envelope and resets the channel it names, with a log
  line: `DATA` past credit or over 64 KiB, `DATA`/`END` after the direction
  ended, `CREDIT` of 0 or past 4 MiB outstanding, a second `STOP`, wrong-parity,
  reused or 65th `OPEN`, unknown type, too short. Pinned in `link-rules.test.ts`.
- An envelope for a number the peer opened earlier but this side no longer
  holds is late traffic: dropped without a log. Only a never-opened number warns.
- Waiting behind the bulk lane never counts toward the stall timer.
- Envelopes, credit and lanes are private. No user or user's test names them.
- The Unix-socket IPC the CLI uses has no link and no channels.

## Known gaps

- **The link bounds only its own waits.** A wait for bytes the peer has not
  sent yet is the user's to bound; the gateway relay does it with its 330 s deadline.
