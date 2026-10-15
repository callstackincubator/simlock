# Daemon protocol

Does: newline-delimited JSON framing for the unix socket, and the one protocol number.
Entry: `index.ts` → `parseRequestFrame`, `parseDaemonResponse`, `serializeFrame`, `DAEMON_PROTOCOL_VERSION`.
Uses: contract. Used by: `DaemonServer` (requests), `SimlockWire` (responses, pushes).

- `DAEMON_PROTOCOL_VERSION` is `PROTOCOL_VERSION_RANGE.max`; it declares no version of its own.
- It checks the envelope only (`id`, `type`, `ok`, `push`); payloads are the dispatcher's.
