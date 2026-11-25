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
  readonly connection?: IpcConnection;
  readonly connector?: IpcConnector;
  readonly endpoint?: string;
  readonly principal?: string;
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
