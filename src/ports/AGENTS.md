# Ports

Does: one interface per external API, each with a Node adapter and a fake.

## Rules

- Application code never imports `fs` or `child_process`, or calls `Date.now()` or
  `setTimeout`: it takes a port. `no-fs-or-process` in `.dependency-cruiser.mjs` fails such an
  import in every file under `src/` outside `ports/`, `test-support/` and the tests;
  `src/lint-rules.test.ts` holds the clock half.
- The real adapters are built once, in the composition root (`src/daemon/main.ts` and its parts, or the
  CLI and MCP environment builders), and injected.
- A port is as small as its callers need. What the bytes mean is the caller's business
  (`TcpProbe.send` knows nothing of adb).
- Every wait an adapter makes is bounded (architecture rule 11). One is not: `copyTree`'s
  fallback that runs no child process, where `timeoutMs` bounds nothing.

Lazy loading:

- Only `uplink-websocket.ts`, `upgrade-router.ts` and `websocket-client.ts` name `ws`. The first two
  load it statically, so they stay out of the barrel (`index.ts`); tests get the uplink adapters
  from `testing.ts`. The last loads it with `import()` on its first `connect`, so in the CLI and
  the MCP server only `simlock tunnel` ever loads it.
- `sqlite.ts` is the only file that names `node:sqlite`, loaded with a dynamic `import()` on first
  open. On a Node without it `open` throws `SqliteUnavailableError`.
- `filterSqliteExperimentalWarning` drops Node's one SQLite `ExperimentalWarning` and no other. A
  process calls it before its first open.

Files and modes:

- A file that holds state or secrets is created owner-only: the logs `NodeFileLogSink` opens, the
  log `NodeDaemonLauncher` pre-creates, and a database `NodeSqliteOpener` opens for writing (SQLite
  gives `-wal` and `-shm` the main file's mode). The data directory gets `DATA_DIRECTORY_MODE`.
- `mkdirp` with a `mode` gives exactly that mode to every directory it creates, parents included,
  past the umask. It never changes a directory that exists.
- `resolveDaemonHome` is the one place the choice between the worker's and the gateway's folder
  lives. The CLI and the MCP server call it; a daemon never does, it derives its folder from its role.
- `launcherFor` (`service-launcher.ts`) is the one start choice for the CLI and the MCP server:
  kickstart a loaded service, else spawn a daemon.
- The loopback ports (`TcpProbe`, `TcpStreamConnector`, `TcpListenerFactory`) use `127.0.0.1`
  unless the caller names `::1`.

Windows:

- `resolveDaemonSocketPath` answers a named pipe there, because Node cannot listen on a file
  path. A pipe is not a file: it is never `stat`ed (a live one fails `EBUSY`), removed or given a
  directory. Ask `isPipeEndpoint` first.
- No directory guards a pipe. The default pipe ACL lets other accounts only read, and a client
  needs read and write. A second listener fails `address-in-use`.
- Every child an adapter starts sets `windowsHide`: the daemon has no console, so a console
  program would open a window.
- A `.bat` or `.cmd` runs through `cmd.exe` (`windows-command.ts`), and an argument holding `%`,
  `"` or a line break is refused.

## Adding an external API

1. A new `<name>.ts` here: the interface, the Node adapter, and a fake in the same file.
2. Bound every wait the adapter makes (architecture rule 11).
3. Export all three from `index.ts`, unless the adapter loads a heavy dependency: then
   keep it out of the barrel and re-export it from `testing.ts` for tests.
4. Build the adapter once in the composition root; pass it in through options.
5. Callers take the interface; their tests pass the fake.

## Known gaps

- **Another local account can take the daemon's pipe on Windows.** The pipe's name is
  predictable. An account that creates it before the daemon starts receives the CLI's `hello`,
  with any `--token` or `SIMLOCK_ADMIN_TOKEN`, and answers in the daemon's place. Accepted for
  single-user machines only, in the 2026-10-30 amendment to ADR 0003 section 4.
