/**
 * `simlock/admin` (ADR 0003 §10). Extends `simlock/client`'s agent surface with the `admin`
 * rows of ADR §3's operation matrix. The split from `simlock/client` is by import path only --
 * the daemon's own role check is what actually stops an agent-role session from calling one of
 * these; nothing here enforces roles client-side beyond simply not exposing the methods.
 */
import {
  NodeIpcTransport,
  type Clock,
  type IpcConnection,
  type IpcConnector,
  type WebSocketClientConnector,
} from "../ports/index.js";
import {
  connectSimlockClient,
  type ConnectOptions,
  type SimlockAdminClient,
} from "../simlock-client/client.js";
import { remoteConnectOptions } from "../simlock-client/remote-connector.js";

export type {
  AlertsTestInput,
  AlertsTestOutput,
  AnySimlockError,
  BaselineListOutput,
  BaselineRemoveInput,
  BaselineRemoveOutput,
  BaselineSaveInput,
  BaselineSaveOutput,
  CatalogGetInput,
  CatalogGetOutput,
  ComponentListInput,
  ComponentListOutput,
  ComponentRemoveInput,
  ComponentRemoveOutput,
  CleanupRunInput,
  CleanupRunOutput,
  ComponentInstallInput,
  ComponentInstallOutput,
  ComponentInstallProgress,
  DaemonStopOutput,
  DaemonUpdateInput,
  DaemonUpdateOutput,
  DeviceAddInput,
  DeviceAddOutput,
  DeviceRecoveredPush,
  DeviceRemoveInput,
  DeviceRemoveOutput,
  DeviceUnhealthyPush,
  ExecInput,
  ExecOutput,
  RotateInput,
  RotateOutput,
  DeviceOutputChunk,
  ExecOptions,
  DoctorReport,
  DoctorRunInput,
  EventPush,
  EventsReplayInput,
  EventsReplayOutput,
  EventsSubscribeOutput,
  EventsUnsubscribeOutput,
  InstallComponentOnWorkersOptions,
  InstallComponentOptions,
  MakeSeedOptions,
  SeedMakeInput,
  SeedMakeOutput,
  SeedProgressUpdate,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseListOutput,
  LeaseLostPush,
  LeaseProgress,
  LeaseReleaseAllOutput,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseReleaseRunInput,
  LeaseReleaseRunOutput,
  LeaseRenewInput,
  LeaseRecord,
  LeaseRequestInput,
  ListGetInput,
  ListGetOutput,
  NukeReport,
  NukeRunInput,
  WarmForgetInput,
  WarmForgetOutput,
  RequestLeaseOptions,
  SimlockAdminClient,
  SimlockConfig,
  SimlockErrorCode,
  StatusGetOutput,
  TokenCreateInput,
  TokenCreateOutput,
  TokenListOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
  UsageGetInput,
  UsageGetOutput,
  WorkerComponentProgress,
  WorkerDrainInput,
  WorkerDrainOutput,
  WorkerInstallComponentInput,
  WorkerInstallComponentOutput,
  WorkerListOutput,
  WorkerRemoveOutput,
  WorkerUndrainOutput,
  WorkerUpdateInput,
  WorkerUpdateOutput,
  WorkerView,
} from "../simlock-client/client.js";
export { isSimlockError, SimlockError } from "../simlock-client/client.js";

/** Same as `simlock/client`'s `ConnectSimlockOptions`, plus `credential` -- ADR §5's first
 * resolution source ("the `credential` connect option (programmatic client)"). A missing or
 * wrong credential fails the handshake with `ADMIN_AUTHENTICATION_FAILED` before any other
 * request is ever sent on this connection. */
export interface ConnectSimlockAdminOptions {
  readonly connection?: IpcConnection;
  readonly endpoint?: string;
  readonly ipc?: IpcConnector;
  readonly principal?: string;
  readonly credential?: string;
  readonly url?: string;
  readonly token?: string;
  /** Lets `url` name an `http://` farm on any host; the token then travels unencrypted. Ignored without `url`. */
  readonly allowInsecureHttp?: boolean;
  readonly webSocket?: WebSocketClientConnector;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** Opens one connection to the daemon and completes the `hello` handshake, requesting the
 * admin role via `credential`. */
export async function connectSimlockAdmin(
  options: ConnectSimlockAdminOptions,
): Promise<SimlockAdminClient> {
  const remote = remoteConnectOptions(options);
  if (remote !== undefined) return connectSimlockClient(remote, true);
  const resolved: ConnectOptions = {
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.connection === undefined
      ? { connector: options.ipc ?? new NodeIpcTransport() }
      : {}),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  };
  return connectSimlockClient(resolved, true);
}
