export {
  type Filesystem,
  isMissingPathError,
  MemoryFilesystem,
  NodeFilesystem,
} from "./filesystem.js";
export type { PathDetails } from "./filesystem.js";
export { resolveSimlockHome } from "./paths.js";
export { type DaemonLauncher, FakeDaemonLauncher, NodeDaemonLauncher } from "./daemon-launcher.js";
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
export { type Clock, FakeClock, SystemClock, type TimerHandle } from "./clock.js";
export {
  JsonLinesLogger,
  type LogLevel,
  type Logger,
  MemoryLogSink,
  NodeFileLogSink,
  NoopLogger,
} from "./logger.js";
// fallow-ignore-next-line unused-type -- public sink contract for consumers that implement their own.
export type { LogSink } from "./logger.js";
// fallow-ignore-next-line unused-type -- public shape of a parsed log line, for consumers of MemoryLogSink.records.
export type { LogRecord } from "./logger.js";
export { CryptoIdGenerator, type IdGenerator } from "./id-generator.js";
export { CryptoTokenSecrets, type TokenSecrets } from "./token-secrets.js";
export { FakeSystemStats, NodeSystemStats, type SystemStats } from "./system-stats.js";
export { FakeParentWatch, NodeParentWatch, type ParentWatch } from "./parent-watch.js";
export type { ParentWatchHandle } from "./parent-watch.js";
export { FakeProcessSupervisor, NodeProcessSupervisor } from "./process-supervisor.js";
export type { ProcessSupervisor } from "./process-supervisor.js";
// fallow-ignore-next-line unused-type -- public shape of FakeProcessSupervisor.signals.
export type { SignalRecord } from "./process-supervisor.js";
export { FakeTcpProbe, NodeTcpProbe } from "./tcp-probe.js";
// fallow-ignore-next-line unused-type -- public shape of FakeTcpProbe.sends.
export type { FakeSend } from "./tcp-probe.js";
export type { TcpProbe } from "./tcp-probe.js";
export {
  exitCodeOf,
  NodeProcessRunner,
  type ProcessHandle,
  ProcessSpawnError,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  // fallow-ignore-next-line unused-type -- public port contract for consumers implementing their own ProcessRunner.
  type ProcessStreamOptions,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
  type StreamingProcessHandle,
  // fallow-ignore-next-line unused-type -- public port contract; what `StreamingProcessHandle.wait()` resolves to.
  type StreamingProcessResult,
} from "./process-runner.js";
