/**
 * `simlock/admin` (ADR 0003 §10). Extends `simlock/client`'s agent surface with the `admin`
 * rows of ADR §3's operation matrix. The split from `simlock/client` is by import path only --
 * the daemon's own role check is what actually stops an agent-role session from calling one of
 * these; nothing here enforces roles client-side beyond simply not exposing the methods.
 */
import { NodeIpcTransport, type IpcConnection, type IpcConnector } from "../ports/index.js";
import {
  connectSimlockClient,
  type ConnectOptions,
  type SimlockAdminClient,
} from "../simlock-client/client.js";

export type {
  AnySimlockError,
  CatalogGetInput,
  CatalogGetOutput,
  CleanupRunInput,
  CleanupRunOutput,
  DaemonStopOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  ExecInput,
  ExecOutput,
  DeviceOutputChunk,
  ExecOptions,
  DoctorReport,
  DoctorRunInput,
  EventPush,
  EventsReplayInput,
  EventsReplayOutput,
  EventsSubscribeOutput,
  EventsUnsubscribeOutput,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseListOutput,
  LeaseLostPush,
  LeaseProgress,
  LeaseReleaseAllOutput,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseRenewInput,
  LeaseRecord,
  LeaseRequestInput,
  ListGetInput,
  ListGetOutput,
  NukeReport,
  NukeRunInput,
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
  WorkerDrainInput,
  WorkerDrainOutput,
  WorkerListOutput,
  WorkerRemoveOutput,
  WorkerUndrainOutput,
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
}

/** Opens one connection to the daemon and completes the `hello` handshake, requesting the
 * admin role via `credential`. */
export async function connectSimlockAdmin(
  options: ConnectSimlockAdminOptions,
): Promise<SimlockAdminClient> {
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
