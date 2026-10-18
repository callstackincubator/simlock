# Ports

Does: one interface per external API, each with a Node adapter and a fake.
Entry: `index.ts` (barrel). The WebSocket uplink adapters are not in it: `uplink-websocket.ts`,
and `testing.ts` for tests.
Uses: nothing from other components. Imported by: every component that touches the machine.

## Ports

| Port                                       | File                        | Node adapter                                                 | Fake                          | What it covers                                            |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| `Clock`                                    | `clock.ts`                  | `SystemClock`                                                | `FakeClock`                   | `now`, `setTimer`, `cancel`                               |
| `Filesystem`                               | `filesystem.ts`             | `NodeFilesystem`                                             | `MemoryFilesystem`            | Read, atomic write, stat, delete, disk free               |
| `ProcessRunner`                            | `process-runner.ts`         | `NodeProcessRunner`                                          | `ScriptedProcessRunner`       | Run or stream a command, capture output                   |
| (wrapper)                                  | `logging-process-runner.ts` | `LoggingProcessRunner`                                       | —                             | One `process` log line per command, at `debug` only       |
| `ProcessSupervisor`                        | `process-supervisor.ts`     | `NodeProcessSupervisor`                                      | `FakeProcessSupervisor`       | Is a pid alive; signal it                                 |
| `ParentWatch`                              | `parent-watch.ts`           | `NodeParentWatch`                                            | `FakeParentWatch`             | Call once when a pid exits (polls)                        |
| `DaemonLauncher`                           | `daemon-launcher.ts`        | `NodeDaemonLauncher`                                         | `FakeDaemonLauncher`          | Detached daemon, its log, `DAEMON_STARTUP_TIMEOUT_MS`     |
| `IpcConnector`, `IpcListenerFactory`       | `ipc.ts`                    | `NodeIpcTransport`                                           | `MemoryIpcTransport`          | The daemon's unix socket                                  |
| `UplinkConnector`, `UplinkListenerFactory` | `uplink.ts`                 | `WebSocketUplinkConnector`, `WebSocketUplinkListenerFactory` | `MemoryUplinkTransport`       | A worker's uplink to its gateway                          |
| `Logger`, `LogSink`                        | `logger.ts`                 | `JsonLinesLogger`, `NodeFileLogSink`                         | `NoopLogger`, `MemoryLogSink` | JSON-line logs, `child(module)`, rotation                 |
| `SystemStats`                              | `system-stats.ts`           | `NodeSystemStats`                                            | `FakeSystemStats`             | CPU count, total RAM                                      |
| `HostInfo`                                 | `host-info.ts`              | `NodeHostInfo`                                               | `FakeHostInfo`                | OS, version (`sw_vers` on macOS), arch                    |
| `HostLoadProbe`                            | `host-load.ts`              | `DarwinHostLoadProbe`, `LinuxHostLoadProbe`                  | `FakeHostLoadProbe`           | CPU, memory, disk counters                                |
| `TcpProbe`                                 | `tcp-probe.ts`              | `NodeTcpProbe`                                               | `FakeTcpProbe`                | Is a loopback port listening; send bytes                  |
| `TcpStreamConnector`                       | `tcp-stream.ts`             | `NodeTcpStreamConnector`                                     | `FakeTcpStreamConnector`      | A long-lived loopback connection, bytes both ways         |
| `BytePipeLauncher`                         | `byte-pipe.ts`              | `NodeBytePipeLauncher`                                       | `FakeBytePipeLauncher`        | A child with binary stdout and stdin as its liveness      |
| `IdGenerator`                              | `id-generator.ts`           | `CryptoIdGenerator`                                          | none; tests inline one        | Random ids                                                |
| `TokenSecrets`                             | `token-secrets.ts`          | `CryptoTokenSecrets`                                         | none; tests inline one        | New secret, its hash                                      |
| Paths                                      | `paths.ts`                  | `resolveSimlockHome`, `resolveDaemonSocketPath`              | —                             | `SIMLOCK_HOME` (default `~/.simlock`), socket path length |

`productionHostLoadProbe` picks the Darwin or Linux probe. `NodeFileLogSink` rotates to
`<path>.1`, or keeps numbered generations when given `retentionMs` or `totalMaxBytes`. The
files it opens, and the log `NodeDaemonLauncher` pre-creates, are opened mode `0600`.

## Rules

- Application code never imports `fs` or `child_process`, or calls `Date.now()` or
  `setTimeout`: it takes a port. Lint fails core, leasing, agent-device, host-load and stream on an
  `fs` or `child_process` import (`no-fs-or-process` in `.dependency-cruiser.mjs`).
- The real adapters are built once, in the composition root (`src/daemon/main.ts`, or the
  CLI and MCP environment builders), and injected.
- Only `uplink-websocket.ts` imports `ws`, so the CLI and MCP never load it.
- A port is as small as its callers need. What the bytes mean is the caller's business
  (`TcpProbe.send` knows nothing of adb).

## Adding an external API

1. A new `<name>.ts` here: the interface, the Node adapter, and a fake in the same file.
2. Bound every wait the adapter makes (architecture rule 11).
3. Export all three from `index.ts`, unless the adapter loads a heavy dependency: then
   keep it out of the barrel and re-export it from `testing.ts` for tests.
4. Build the adapter once in the composition root; pass it in through options.
5. Callers take the interface; their tests pass the fake.
6. A row in the table above.
