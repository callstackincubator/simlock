# Daemon protocol

Does: newline-delimited JSON framing for the unix socket, and the one protocol number.

## Rules

- `DAEMON_PROTOCOL_VERSION` is `PROTOCOL_VERSION_RANGE.max` (contract); this module declares no version of its own.
- It checks the envelope only; payloads are the dispatcher's.
