/**
 * `simlock/client` (ADR 0003 §10). The one supported way for a host process to allocate
 * devices over the daemon's unix socket without spawning a command. No reconnect, no retry --
 * see `../simlock-client/client.ts`'s module comment for why.
 *
 * This module (and `simlock/admin`) is the entire public surface: everything it exports is
 * derived from `src/contract`'s zod schemas, never a core-private type
 * (`DeviceRecord`/`LeaseRecord`/`LeaseGrant`-the-core-type stay inside the daemon) -- see
 * `no-core-leak.test.ts`.
 */
import { NodeIpcTransport, type IpcConnection, type IpcConnector } from "../ports/index.js";
import {
  connectSimlockClient,
  type ConnectOptions,
  type SimlockClient,
} from "../simlock-client/client.js";

export type {
  AnySimlockError,
  CatalogGetInput,
  CatalogGetOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  DoctorReport,
  DoctorRunInput,
  LeaseCancelInput,
  LeaseCancelOutput,
  LeaseGrant,
  LeaseHeartbeatOutput,
  LeaseListOutput,
  LeaseLostPush,
  LeaseProgress,
  LeaseReleaseInput,
  LeaseReleaseOutput,
  LeaseRenewInput,
  LeaseRecord,
  LeaseRequestInput,
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
  /** A pre-connected transport -- mainly for tests (a scripted `IpcConnection`). Exactly one of
   * `connection`/`endpoint` must be given. */
  readonly connection?: IpcConnection;
  /** The daemon's unix socket path. Connected via `ipc` (defaults to the real
   * `NodeIpcTransport`) when `connection` is not given directly. */
  readonly endpoint?: string;
  readonly ipc?: IpcConnector;
  readonly principal?: string;
  readonly heartbeat?: boolean;
}

/** Opens one connection to the daemon and completes the `hello` handshake as an agent-role
 * session. Rejects with a `SimlockError` (`PROTOCOL_VERSION_UNSUPPORTED`,
 * `ADMIN_AUTHENTICATION_FAILED` never applies here since no credential is sent,
 * `DAEMON_CONNECTION_LOST` if the socket cannot be reached) without ever restarting the
 * daemon -- see `docs/adr/0003-...md` §6. */
export async function connectSimlock(options: ConnectSimlockOptions): Promise<SimlockClient> {
  const resolved: ConnectOptions = {
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.connection === undefined
      ? { connector: options.ipc ?? new NodeIpcTransport() }
      : {}),
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
  };
  return connectSimlockClient(resolved, false);
}
