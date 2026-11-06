# Link

Does: wraps one uplink transport connection; carries text messages and byte channels, small messages first.

## Rules

Portability:

- The link runs in a browser and in React Native: outside its test helpers it uses no Node module
  and no package, and only the types of ports (lint: `link-is-portable`,
  `link-imports-port-types-only`). A runtime with no `crypto` must pass `generateId`.
- Envelopes, credit and lanes are private. No user or user's test names them.
- The sizes, windows and waits are constants in `envelope.ts`, `channel.ts`, `scheduler.ts` and
  `index.ts`. None is configurable: both ends of a connection must agree on them.
- The Unix-socket IPC the CLI uses has no link and no channels.

Channels:

- The worker numbers its channels odd, the gateway even. A number is never reused on a connection.
- `OPEN` always leaves before the message that names the channel (for example `relay.request`).
- Text received before any `onData` listener is held, then handed to the first one.
- A channel fails only by: peer abort, peer rule break, accept timeout, stall,
  or connection close. `LinkChannelError.reason` says which. The connection stays up.
- A rule break drops the envelope and resets the channel it names, with a log line: `DATA`
  past credit or over `MAX_DATA_BYTES`, `DATA`/`END` after the direction ended, `CREDIT` of 0
  or past `CHANNEL_WINDOW` outstanding, a second `STOP`, a wrong-parity or reused `OPEN` or one
  past `OPEN_LIMIT`, unknown type, too short. Pinned in `link-rules.test.ts`.
- An envelope for a number the peer opened earlier but this side no longer
  holds is late traffic: dropped without a log. Only a never-opened number warns.
- Ending `writable` ends one direction. Cancelling `readable` sends `STOP`, and the peer's
  writer errors `stopped` and answers `END`. `abort` sends `RESET` and ends both.
- A channel frees its slot only once this side's `END` or `RESET` is handed to the transport
  and the peer's has arrived.

Flow control:

- The sender counts a `CREDIT` against bytes handed to the transport, not bytes still queued.
- Waiting behind the bulk lane never counts toward the stall timer.
- Priority messages go first, but bulk still sends one message per `PRIORITY_SHARE` of
  priority (`scheduler.ts`).
- An `openChannel` past `OPEN_LIMIT` waits on its signal; it does not fail.

## Known gaps

- **The link bounds only its own waits.** A wait for bytes the peer has not
  sent yet is the user's to bound; the gateway relay does it with its deadline for the
  head and its idle bound for the body (`GatewayRelayOptions` in `../gateway/relay.ts`).
