/**
 * why: The typed client (ADR 0003 §10): one connection, methods derived from the contract, and one
 * stateful behaviour -- abort. `connectSimlock`/`connectSimlockAdmin` (the two public entry
 * points, `../client/index.ts` and `../admin/index.ts`) both funnel through
 * `connectSimlockClient` here; the split between them is only which type the caller gets back
 * and whether a `credential` is accepted, exactly as the ADR specifies ("the split is by
 * import path; the enforcement is the daemon's role check").
 *
 * This class does not reconnect and does not retry, not even for reads (ADR §10): a dead
 * connection ends the client for good, and every in-flight call rejects with
 * `DAEMON_CONNECTION_LOST` rather than being silently queued for a retry that would need a
 * whole second policy (and would make "reconnecting never implicitly acquires a device" a
 * claim this module could no longer prove).
 */
import { isSimlockError } from "../contract/index.js";
import type { LinkConnection } from "../link/index.js";
import type { IpcConnection, IpcConnector } from "../ports/index.js";
import { SimlockWire } from "./wire.js";
import type { SimlockAdminClient, SimlockClient } from "./client-api.js";
import { buildDegradedClient } from "./client-degraded.js";
import { createSimlockClient } from "./client-impl.js";

export type {
  BaselineListOutput,
  BaselineRemoveInput,
  BaselineRemoveOutput,
  BaselineSaveInput,
  BaselineSaveOutput,
  CatalogGetInput,
  CatalogGetOutput,
  CleanupRunInput,
  CleanupRunOutput,
  ComponentInstallInput,
  ComponentInstallOutput,
  ComponentInstallProgress,
  ComponentListInput,
  ComponentListOutput,
  ComponentRemoveInput,
  ComponentRemoveOutput,
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
  DoctorReport,
  DoctorRunInput,
  DriverPassthroughInput,
  EventPush,
  ExecOptions,
  EventsReplayInput,
  EventsReplayOutput,
  UsageGetInput,
  UsageGetOutput,
  EventsSubscribeOutput,
  EventsUnsubscribeOutput,
  InstallComponentOnWorkersOptions,
  IdentityOutput,
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
  PassthroughCommand,
  ListGetInput,
  ListGetOutput,
  NukeReport,
  NukeRunInput,
  WarmForgetInput,
  WarmForgetOutput,
  RequestLeaseOptions,
  SimlockConfig,
  StatusGetOutput,
  TokenCreateInput,
  TokenCreateOutput,
  TokenListOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
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
  AlertsTestInput,
  AlertsTestOutput,
} from "./types.js";
export {
  isSimlockError,
  SimlockError,
  type AnySimlockError,
  type SimlockErrorCode,
} from "../contract/index.js";
export type { RelayClientMethods, SimlockAdminClient, SimlockClient } from "./client-api.js";

export interface ConnectOptions {
  /** why: Pre-connected transport (a scripted `IpcConnection` in tests, or the real result of an
   * `IpcConnector`). It wins when set; otherwise `connector` and `endpoint` are both needed. */
  readonly connection?: IpcConnection;
  readonly connector?: IpcConnector;
  readonly endpoint?: string;
  readonly principal?: string;
  /** why: ADR §5's first credential source in the resolution order: "the `credential` connect
   * option (programmatic client)". Only meaningful via `connectSimlockAdmin` -- the base
   * `connectSimlock` does not accept one, by design (ADR §10: "the split is by import path"). */
  readonly credential?: string;
  /** why: the longest unfinished line the wire keeps before it closes the connection; a peer
   * with a smaller largest reply than the local socket's (the gateway's worker uplink) sets its own. */
  readonly maxLineChars?: number;
}

export async function connectSimlockClient(
  options: ConnectOptions,
  admin: false,
): Promise<SimlockClient>;
export async function connectSimlockClient(
  options: ConnectOptions,
  admin: true,
): Promise<SimlockAdminClient>;
export async function connectSimlockClient(
  options: ConnectOptions,
  admin: boolean,
): Promise<SimlockClient | SimlockAdminClient> {
  const connection = await resolveConnection(options);
  const wire = new SimlockWire(connection, options.maxLineChars);
  let hello: Awaited<ReturnType<SimlockWire["hello"]>>;
  try {
    hello = await wire.hello({
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    });
  } catch (error: unknown) {
    // why: ADR §6: a `PROTOCOL_VERSION_UNSUPPORTED` `hello` rejection is the one handshake failure
    // the daemon deliberately keeps the connection open for -- an admin client whose range
    // does not overlap the daemon's must still be able to send `daemon.stop` on *this*
    // connection instead of restarting it (see the comments around the mismatch reply in
    // `daemon/server-hello.ts`'s `Handshake.handle`, and `daemon/server.ts`'s `#dispatchLine`'s
    // `daemon.stop`-ahead-of-the-mismatch-gate check). Closing here -- every other handshake
    // failure, a bad credential (`ADMIN_AUTHENTICATION_FAILED`) included -- still closes and
    // serves nothing.
    if (isSimlockError(error) && error.code === "PROTOCOL_VERSION_UNSUPPORTED") {
      return buildDegradedClient(wire, error, options.principal ?? "", admin);
    }
    await connection.close();
    throw error;
  }
  const impl = createSimlockClient(
    wire,
    hello.role,
    hello.principal,
    hello.daemonVersion,
    isLinkConnection(connection) ? connection : undefined,
  );
  return admin ? impl.asAdmin() : impl;
}

function isLinkConnection(connection: IpcConnection): connection is LinkConnection {
  return typeof (connection as Partial<LinkConnection>).openChannel === "function";
}

async function resolveConnection(options: ConnectOptions): Promise<IpcConnection> {
  if (options.connection !== undefined) return options.connection;
  if (options.connector !== undefined && options.endpoint !== undefined) {
    return options.connector.connect(options.endpoint);
  }
  throw new Error(
    "connectSimlock requires either `connection` (a pre-connected transport) or both `connector` and `endpoint`",
  );
}
