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
  type SimlockClient,
} from "../simlock-client/client.js";
import { remoteConnectOptions } from "../simlock-client/remote-connector.js";

export type {
  AnySimlockError,
  CatalogGetInput,
  CatalogGetOutput,
  ComponentListInput,
  ComponentListOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  ExecInput,
  ExecOutput,
  RotateInput,
  RotateOutput,
  DeviceOutputChunk,
  ExecOptions,
  DoctorReport,
  DoctorRunInput,
  DriverPassthroughInput,
  IdentityOutput,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseListOutput,
  LeaseLostPush,
  LeaseProgress,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseReleaseRunInput,
  LeaseReleaseRunOutput,
  LeaseRenewInput,
  LeaseRecord,
  LeaseRequestInput,
  PassthroughCommand,
  RequestLeaseOptions,
  SimlockClient,
  SimlockErrorCode,
  StatusGetOutput,
} from "../simlock-client/client.js";
export { isSimlockError, SimlockError } from "../simlock-client/client.js";

/** A caller-facing subset of `ConnectOptions` -- `credential` is deliberately not accepted
 * here (ADR §10: "the split is by import path"). Use `connectSimlockAdmin` from
 * `simlock/admin` for an admin-role connection. */
export interface ConnectSimlockOptions {
  readonly connection?: IpcConnection;
  readonly endpoint?: string;
  readonly ipc?: IpcConnector;
  readonly principal?: string;
  readonly url?: string;
  readonly token?: string;
  /** Lets `url` name an `http://` farm on any host; the token then travels unencrypted. Ignored without `url`. */
  readonly allowInsecureHttp?: boolean;
  readonly webSocket?: WebSocketClientConnector;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

/** Opens one connection to the daemon and completes the `hello` handshake as an agent-role
 * session (with `url` and `token`, as the token's role). Rejects with a `SimlockError`
 * (`PROTOCOL_VERSION_UNSUPPORTED`, `ADMIN_AUTHENTICATION_FAILED` never applies here since no
 * credential is sent, `DAEMON_CONNECTION_LOST` if the socket cannot be reached,
 * `REMOTE_UNREACHABLE` or `UNAUTHENTICATED` if a farm at `url` cannot be reached or refuses
 * the token) without ever restarting the daemon -- see `docs/internal/adr/0003-...md` §6. */
export async function connectSimlock(options: ConnectSimlockOptions): Promise<SimlockClient> {
  const remote = remoteConnectOptions(options);
  if (remote !== undefined) return connectSimlockClient(remote, false);
  const resolved: ConnectOptions = {
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.connection === undefined
      ? { connector: options.ipc ?? new NodeIpcTransport() }
      : {}),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
  };
  return connectSimlockClient(resolved, false);
}
