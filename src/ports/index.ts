export {
  type Filesystem,
  isMissingPathError,
  MemoryFilesystem,
  NodeFilesystem,
} from "./filesystem.js";
export type { PathDetails } from "./filesystem.js";
export { readPackageVersion } from "./package-version.js";
export {
  daemonDataDirectory,
  type DaemonRole,
  type DaemonFlag,
  type DaemonHome,
  resolveDaemonHome,
  resolveDaemonSocketPath,
  resolveSimlockHome,
  SocketPathTooLongError,
} from "./paths.js";
export {
  DAEMON_STARTUP_TIMEOUT_MS,
  type DaemonExit,
  type DaemonLauncher,
  FakeDaemonLauncher,
  type LaunchedDaemon,
  NodeDaemonLauncher,
  startErrorFrom,
  startTimeoutMessage,
} from "./daemon-launcher.js";
export {
  type IpcConnection,
  type IpcConnector,
  IpcError,
  type IpcListenerFactory,
  MemoryIpcTransport,
  NodeIpcTransport,
} from "./ipc.js";
// fallow-ignore-next-line unused-type -- public port contract for consumers that need normalized error codes.
export type { IpcErrorCode } from "./ipc.js";
// fallow-ignore-next-line unused-type -- public listener lifecycle contract.
export type { IpcListener } from "./ipc.js";
export { launcherFor } from "./service-launcher.js";
export {
  FakeServiceManager,
  LaunchdServiceManager,
  productionServiceManager,
  ServiceFailedError,
  type ServiceDefinition,
  type ServiceManager,
  serviceDefinition,
  type ServiceManagerName,
  type ServiceState,
} from "./service-manager.js";
export { type Clock, FakeClock, SystemClock, type TimerHandle } from "./clock.js";
/**
 * ADR 0005 §33's uplink port and its in-memory adapter. The WebSocket adapters are
 * deliberately *not* re-exported here: they live in `./uplink-websocket.js`, the one module
 * that imports `ws`, and only the daemon entrypoint needs them -- so the CLI and the MCP
 * server, which import this barrel, never load a WebSocket implementation they never use.
 */
export {
  createConnectionPair,
  MemoryUplinkTransport,
  uplinkOutcome,
  UplinkError,
  type AcceptedUplink,
  type UplinkAuthOutcome,
  type UplinkAuthResult,
  type UplinkConnector,
  type UplinkDialOptions,
  type UplinkListener,
  type MemoryTransportConnection,
  type UplinkListenerFactory,
  type UplinkTransportConnection,
} from "./uplink.js";
// fallow-ignore-next-line unused-type -- public port contract for consumers that branch on why a dial failed.
export type { UplinkErrorCode } from "./uplink.js";
export {
  JsonLinesLogger,
  type LogLevel,
  type Logger,
  MemoryLogSink,
  NodeFileLogSink,
  NoopLogger,
} from "./logger.js";
// fallow-ignore-next-line unused-type -- public shape of a parsed log line, for consumers of MemoryLogSink.records.
export type { LogRecord } from "./logger.js";
export {
  FakeKeySetFetcher,
  KEY_SET_MAX_BYTES,
  type KeySetFetcher,
  NodeKeySetFetcher,
} from "./key-set-fetcher.js";
export { CryptoIdGenerator, type IdGenerator } from "./id-generator.js";
export { CryptoTokenSecrets, type TokenSecrets } from "./token-secrets.js";
export { FakeSystemStats, NodeSystemStats, type SystemStats } from "./system-stats.js";
export { FakeHostInfo, type HostInfo, type HostSystem, NodeHostInfo } from "./host-info.js";
export { FakeParentWatch, NodeParentWatch, type ParentWatch } from "./parent-watch.js";
export type { ParentWatchHandle } from "./parent-watch.js";
export { FakeProcessSupervisor, NodeProcessSupervisor } from "./process-supervisor.js";
export type { ProcessSupervisor } from "./process-supervisor.js";
// fallow-ignore-next-line unused-type -- public shape of FakeProcessSupervisor.signals.
export type { SignalRecord } from "./process-supervisor.js";
export { FakeTcpProbe, NodeTcpProbe } from "./tcp-probe.js";
export {
  FakeTcpStreamConnector,
  NodeTcpStreamConnector,
  type TcpStream,
  type TcpStreamConnector,
} from "./tcp-stream.js";
export {
  type BytePipeLauncher,
  type BytePipeProcess,
  FakeBytePipeLauncher,
  NodeBytePipeLauncher,
} from "./byte-pipe.js";
// fallow-ignore-next-line unused-type -- public shape of FakeTcpProbe.sends.
export type { FakeSend } from "./tcp-probe.js";
export type { TcpProbe } from "./tcp-probe.js";
export { LoggingProcessRunner } from "./logging-process-runner.js";
export {
  exitCodeOf,
  ExecOutputDeliveryStalledError,
  NodeProcessRunner,
  type ProcessHandle,
  ProcessSpawnError,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ProcessStreamOptions,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  type StreamingProcessHandle,
  type StreamingProcessResult,
} from "./process-runner.js";
export {
  type CpuCounters,
  type CpuTimes,
  DarwinHostLoadProbe,
  type DiskCounters,
  FakeHostLoadProbe,
  type HostLoadCounters,
  type HostLoadProbe,
  LinuxHostLoadProbe,
  type MemoryCounters,
  productionHostLoadProbe,
} from "./host-load.js";
export {
  filterSqliteExperimentalWarning,
  inTransaction,
  isLockError,
  NodeSqliteOpener,
  passesQuickCheck,
  SqliteUnavailableError,
} from "./sqlite.js";
export type {
  SqliteDatabase,
  SqliteOpener,
  SqliteSchemaOwner,
  SqliteStatement,
  SqliteValue,
} from "./sqlite.js";
export { FetchWebhookPoster, type WebhookPoster } from "./webhook-poster.js";
export { FakeNpmCli, NodeNpmCli, type NpmCli, type NpmOutcome } from "./npm-cli.js";
export {
  // fallow-ignore-next-line unused-export -- the launcher's callers arrive with the daemon's update call (#836).
  FakeUpdaterLauncher,
  // fallow-ignore-next-line unused-type -- same.
  type LaunchedUpdater,
  // fallow-ignore-next-line unused-export -- same.
  NodeUpdaterLauncher,
  // fallow-ignore-next-line unused-type -- same.
  type UpdaterLaunch,
  // fallow-ignore-next-line unused-type -- same.
  type UpdaterLauncher,
} from "./updater-launcher.js";
