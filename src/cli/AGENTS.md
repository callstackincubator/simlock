# CLI

Does: the `simlock` command surface over `simlock/admin` — parse, render, hold a lease while alive.
Surface: [cli.mdx](../../website/src/content/docs/docs/reference/cli.mdx) — every command and flag; [errors.mdx](../../website/src/content/docs/docs/reference/errors.mdx) — exit codes.

## Rules

Routing:

- No decision logic and no state beyond the lease it holds (architecture rule 8).
- The router loads nothing. The shared files the dependency rule `cli-router-imports-no-component-values` names (`.dependency-cruiser.mjs`) import no component for a value, so `--help` or a usage error loads no command module. `lazy-loading.test.ts` measures what a command loads when it runs.
- Nothing runs without a command node: an unmatched word is a usage error before any command module is read.
- With `--gateway` and no gateway present, a command stops with `GATEWAY_NOT_PRESENT` before it connects; the commands that can run without one are exempt.
- `CliEnvironment` carries every port and process handle; tests build it with fakes.

Connect and auto-launch:

- A missing or rejected credential is not an error: the command gets an `agent` session and one stderr `notice` line.
- Auto-launch loads the config first, so a bad one fails on this command's stderr.
- A launched daemon that exits fails the command at once, unless another daemon answers a last connect. A start through the service never reports an exit, so a daemon it refuses fails at the deadline with the `daemon.log` lines since the start.
- An answered probe ends the startup window, a `starting` status included: later command failures keep their own codes even while a lease queues or boots.
- The connector keeps the launch deadline across a rejected credential and the agent fallback.
- A pre-existing daemon is never probed or reclassified.
- `daemon start` that still sees `starting` at its limit fails with `DAEMON_STARTUP_FAILED` and leaves the daemon running.

Holding a lease:

- The connection holds nothing: a lease ends by release or TTL. A lost connection is `DAEMON_CONNECTION_LOST`, and the lease runs to its deadline.
- Renewal stops before the release; no timer outlives a command.
- A signal or a parent exit during the request aborts it (the client cancels the queued request) and exits 0.

Passthrough and tunnel:

- `simctl` and `adb`: on a worker the scoped command runs here (`spawnPassthrough`). Through a gateway it is `device.exec`: the worker's driver fills the lease's device in and refuses another (ADR 0047).
- Without `--stdin`, stdin is never read and `stdin: ""` is sent (ADR 0058). A worker ignores `--stdin`.
- `tunnel` talks to a worker or gateway over HTTP and a WebSocket, never the local daemon. `ws` loads on the first connect, for this command only.
- A forward tunnel binds its caller port before anything else, and holds accepted connections until `READY`.
- `tunnel emulator adb`: a failed `adb connect` is a warning and the tunnel stays. Leaving always runs `adb disconnect`, and the exit code is the command's own.

Events and history:

- `events --follow`: subscribe, then replay, then print buffered pushes not already replayed (by `eventKey`).
- `--since` without `--follow` never launches a daemon; with none running it reads `history.db` itself, read-only.
- `stats` computes no figure: it prints what `usage.get` answers.

Output:

- Any error is one JSON line on stderr, `{ error: { code, message } }`.
- Every renderer and text-printing command passes remote text through `escapeControl` (`escape.ts`).
- `ledgerCsv` (`csv.ts`) puts a `'` before a leading `=`, `+`, `-` or `@`.
- `setup`: a missing platform never changes the exit code, and a check that cannot run is `not checked`.
- Nothing printed names a file path in this repo (documentation rule 3).
