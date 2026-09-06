/**
 * The typed client (ADR 0003 §10): one connection, methods derived from the contract, and one
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
import type { z } from "zod";

import {
  describeSchemaIssues,
  fromWireError,
  isSimlockError,
  OPERATIONS,
  SimlockError,
  type AnySimlockError,
  type OperationName,
  type Role,
} from "../contract/index.js";
import type { IpcConnection, IpcConnector } from "../ports/index.js";
import { SimlockWire, WireCallError, type LeaseScopedPush } from "./wire.js";
import type {
  CatalogGetInput,
  CatalogGetOutput,
  CleanupRunInput,
  CleanupRunOutput,
  DaemonStopOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  DeviceExecInput,
  DeviceExecOutput,
  DeviceOutputChunk,
  DoctorReport,
  DoctorRunInput,
  DriverPassthroughInput,
  EventPush,
  ExecDeviceOptions,
  EventsReplayInput,
  EventsReplayOutput,
  LeaseCancelInput,
  LeaseCancelOutput,
  PassthroughCommand,
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
  SimlockConfig,
  StatusGetOutput,
  TokenCreateInput,
  TokenCreateOutput,
  TokenListOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
} from "./types.js";

export type {
  CatalogGetInput,
  CatalogGetOutput,
  CleanupRunInput,
  CleanupRunOutput,
  DaemonStopOutput,
  DeviceRecoveredPush,
  DeviceUnhealthyPush,
  DeviceExecInput,
  DeviceExecOutput,
  DeviceOutputChunk,
  DoctorReport,
  DoctorRunInput,
  DriverPassthroughInput,
  EventPush,
  ExecDeviceOptions,
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
  PassthroughCommand,
  ListGetInput,
  ListGetOutput,
  NukeReport,
  NukeRunInput,
  RequestLeaseOptions,
  SimlockConfig,
  StatusGetOutput,
  TokenCreateInput,
  TokenCreateOutput,
  TokenListOutput,
  TokenRevokeInput,
  TokenRevokeOutput,
} from "./types.js";
export {
  isSimlockError,
  SimlockError,
  type AnySimlockError,
  type SimlockErrorCode,
} from "../contract/index.js";

export interface ConnectOptions {
  /** Pre-connected transport (a scripted `IpcConnection` in tests, or the real result of an
   * `IpcConnector`). Exactly one of `connection`/`connector` must be given. */
  readonly connection?: IpcConnection;
  /** A connector plus its endpoint -- the normal production path (`NodeIpcTransport` +
   * a socket path). */
  readonly connector?: IpcConnector;
  readonly endpoint?: string;
  /** ADR §4: the connection's fixed principal. Defaults to whatever the daemon assigns when
   * omitted (today: its own default requester id). */
  readonly principal?: string;
  /** ADR §5's first credential source in the resolution order: "the `credential` connect
   * option (programmatic client)". Only meaningful via `connectSimlockAdmin` -- the base
   * `connectSimlock` does not accept one, by design (ADR §10: "the split is by import path"). */
  readonly credential?: string;
}

/** The full agent-visible method surface (ADR §3's operation matrix, `agent` rows) plus the
 * pushes and lifecycle every frontend needs. `simlock/admin`'s `SimlockAdminClient` extends
 * this with the `admin` rows. */
export interface SimlockClient {
  readonly principal: string;
  readonly role: Role;
  readonly daemonVersion: string;

  getCatalog(input?: CatalogGetInput): Promise<CatalogGetOutput>;
  getStatus(): Promise<StatusGetOutput>;
  requestLease(input: LeaseRequestInput, options?: RequestLeaseOptions): Promise<LeaseGrant>;
  cancelLease(input?: LeaseCancelInput): Promise<LeaseCancelOutput>;
  renewLease(input: LeaseRenewInput): Promise<LeaseRecord>;
  releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput>;
  listLeases(): Promise<LeaseListOutput>;
  runDoctor(input?: DoctorRunInput): Promise<DoctorReport>;
  /** Resolves the scoped command behind `simlock simctl` / `simlock adb` (ADR 0001, decision
   * 7). Resolution only -- the caller is the process with a terminal, so it runs it. */
  resolvePassthrough(input: DriverPassthroughInput): Promise<PassthroughCommand>;
  /**
   * Runs `simctl`/`adb` **on the daemon's machine** against a device this client's principal
   * leases, streaming the output to `options.onOutput` as it arrives and resolving with the
   * command's exit code (ADR 0005 §19a). The counterpart to `resolvePassthrough`: that one
   * hands back a command line for a caller sharing the machine, this one is for a caller that
   * does not. `stdin` is written once and closed -- there is no pseudo-terminal, so
   * line-oriented commands work and full-screen ones do not (§19c).
   */
  execDevice(input: DeviceExecInput, options?: ExecDeviceOptions): Promise<DeviceExecOutput>;

  /**
   * Reports a lease the *daemon* ended -- an expiry, an operator release, an unrecoverable
   * device. ADR 0004 §3 narrows ADR 0003 §10 here: a dead connection is not a dead lease, so
   * this no longer fires with a synthesized `daemon-connection-lost` when the socket dies. The
   * leases this client held are still granted and still counting down; `onConnectionLost` is
   * what reports the connection, and reconnecting and renewing is the frontend's call.
   */
  onLeaseLost(listener: (push: LeaseLostPush) => void): () => void;
  onDeviceUnhealthy(listener: (push: DeviceUnhealthyPush) => void): () => void;
  onDeviceRecovered(listener: (push: DeviceRecoveredPush) => void): () => void;
  /** Fires exactly once, when the connection dies for any reason (including a deliberate
   * `close()`). Every in-flight call has already rejected `DAEMON_CONNECTION_LOST` by the time
   * this listener runs. Any lease this client was holding is still alive on the daemon. */
  onConnectionLost(listener: (error: AnySimlockError) => void): () => void;

  close(): Promise<void>;
}

/** `simlock/admin`'s extension: the `admin` rows of ADR §3's matrix. */
export interface SimlockAdminClient extends SimlockClient {
  releaseAllLeases(): Promise<LeaseReleaseAllOutput>;
  list(input?: ListGetInput): Promise<ListGetOutput>;
  runCleanup(input?: CleanupRunInput): Promise<CleanupRunOutput>;
  runNuke(input?: NukeRunInput): Promise<NukeReport>;
  getConfig(): Promise<SimlockConfig>;
  /** ADR §6's frozen exception: accepted by the daemon at any protocol version it has ever
   * spoken, even before `hello`/role resolve. Exposed here rather than on the base client
   * purely as an API-surface choice matching the ADR's operation matrix (the daemon itself
   * does not gate this operation by role at all -- see the caveat in the PR report). */
  stopDaemon(): Promise<DaemonStopOutput>;
  replayEvents(input?: EventsReplayInput): Promise<EventsReplayOutput>;
  subscribeEvents(listener: (event: EventPush) => void): Promise<() => Promise<void>>;
  createToken(input: TokenCreateInput): Promise<TokenCreateOutput>;
  listTokens(): Promise<TokenListOutput>;
  revokeToken(input: TokenRevokeInput): Promise<TokenRevokeOutput>;
}

/** Internal: builds either client. `admin` toggles only which methods the returned object
 * carries (an object literal with/without the extra methods) -- the daemon's own role check is
 * what actually stops an agent-role session from calling one of them; this flag exists purely
 * so `simlock/client` doesn't even show the admin methods in a caller's editor. */
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
  const wire = new SimlockWire(connection);
  let hello: Awaited<ReturnType<SimlockWire["hello"]>>;
  try {
    hello = await wire.hello({
      ...(options.principal === undefined ? {} : { principal: options.principal }),
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    });
  } catch (error: unknown) {
    // ADR §6: a `PROTOCOL_VERSION_UNSUPPORTED` `hello` rejection is the one handshake failure
    // the daemon deliberately keeps the connection open for -- an admin client whose range
    // does not overlap the daemon's must still be able to send `daemon.stop` on *this*
    // connection instead of restarting it (see the comments around the mismatch reply in
    // `daemon/server.ts#handleHello`, and `#dispatchLine`'s `daemon.stop`-ahead-of-the-mismatch-
    // gate check). Closing here -- every other handshake failure, a bad credential
    // (`ADMIN_AUTHENTICATION_FAILED`) included -- still closes and serves nothing.
    if (isSimlockError(error) && error.code === "PROTOCOL_VERSION_UNSUPPORTED") {
      return buildDegradedClient(wire, error, options.principal ?? "", admin);
    }
    await connection.close();
    throw error;
  }
  const impl = new SimlockClientImpl(wire, hello.role, hello.principal, hello.daemonVersion);
  return admin ? impl.asAdmin() : impl;
}

/**
 * ADR §6's escape hatch, on the client side: everything but `stopDaemon()` and `close()`
 * rejects with the captured `PROTOCOL_VERSION_UNSUPPORTED` error (never sent to the daemon --
 * every other operation requires a completed handshake this connection never got); `close()`
 * still works so a caller that decides not to stop the daemon can tidy up. `stopDaemon()` calls
 * straight through the wire: the daemon accepts `daemon.stop` "at any protocol version it has
 * ever spoken" (ADR §6), ahead of its own mismatch gate, specifically so this is reachable.
 *
 * `role`/`principal` cannot be the connection's real resolved values -- the daemon resolves
 * them before the mismatch check but the failed `hello` never reports them back (see the PR
 * report's weak-spots list) -- so `role` reflects which entry point the caller used
 * (`connectSimlock` vs. `connectSimlockAdmin`) rather than a verified fact, and `principal` is
 * whatever the caller supplied (or `""` when it supplied none). Neither is load-bearing here:
 * the only operation this client permits (`daemon.stop`) is gated by the daemon's own role
 * check on the credential it already verified, not by anything this object reports about
 * itself.
 */
function buildDegradedClient(
  wire: SimlockWire,
  error: SimlockError<"PROTOCOL_VERSION_UNSUPPORTED">,
  principal: string,
  admin: boolean,
): SimlockClient | SimlockAdminClient {
  const rejected = <T>(): Promise<T> => Promise.reject(error);
  const client: SimlockAdminClient = {
    principal,
    role: admin ? "admin" : "agent",
    daemonVersion: error.details.daemonVersion,

    getCatalog: () => rejected(),
    getStatus: () => rejected(),
    requestLease: () => rejected(),
    cancelLease: () => rejected(),
    renewLease: () => rejected(),
    releaseLease: () => rejected(),
    listLeases: () => rejected(),
    runDoctor: () => rejected(),
    resolvePassthrough: () => rejected(),
    execDevice: () => rejected(),

    onLeaseLost: () => () => {},
    onDeviceUnhealthy: () => () => {},
    onDeviceRecovered: () => () => {},
    // The one live fact this connection can still report: it can still die later even though
    // `hello` never fully succeeded (e.g. the daemon exits while this degraded client sits
    // idle).
    onConnectionLost: (listener) => wire.onDeath(listener),

    close: () => wire.close(),

    releaseAllLeases: () => rejected(),
    list: () => rejected(),
    runCleanup: () => rejected(),
    runNuke: () => rejected(),
    getConfig: () => rejected(),
    stopDaemon: () =>
      wire.call("daemon.stop", {}).then(
        (payload) => {
          const result = OPERATIONS["daemon.stop"].output.safeParse(payload);
          if (!result.success) {
            throw new SimlockError(
              "BAD_FRAME",
              "protocol",
              "Daemon's daemon.stop response did not match the contract output schema",
              {},
            );
          }
          return result.data;
        },
        (callError: unknown) => {
          throw toSimlockError(callError);
        },
      ),
    replayEvents: () => rejected(),
    subscribeEvents: () => rejected(),
    createToken: () => rejected(),
    listTokens: () => rejected(),
    revokeToken: () => rejected(),
  };
  return client;
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

/**
 * The single implementation both `SimlockClient` and `SimlockAdminClient` are backed by --
 * `asAdmin()` returns the same instance typed with the extra methods, since every admin
 * operation is a plain operation call like any other and there is nothing role-specific to
 * duplicate. It tracks no leases at all: ADR 0004 §3 deleted the one reason it used to
 * (synthesizing `onLeaseLost` on connection death), because a lease outlives the connection
 * that asked for it.
 */
class SimlockClientImpl {
  readonly #wire: SimlockWire;
  readonly #leaseLostListeners = new Set<(push: LeaseLostPush) => void>();
  readonly #deviceUnhealthyListeners = new Set<(push: DeviceUnhealthyPush) => void>();
  readonly #deviceRecoveredListeners = new Set<(push: DeviceRecoveredPush) => void>();
  readonly #connectionLostListeners = new Set<(error: AnySimlockError) => void>();
  #eventSubscriptionId: string | undefined;

  constructor(
    wire: SimlockWire,
    readonly role: Role,
    readonly principal: string,
    readonly daemonVersion: string,
  ) {
    this.#wire = wire;
    wire.onLeaseScopedPush((push) => this.#handleLeaseScopedPush(push));
    wire.onDeath((error) => this.#handleConnectionLost(error));
  }

  asAdmin(): SimlockAdminClient {
    // `this` already implements every method the interface below needs (see the class body) --
    // this cast documents that the split is purely at the type layer.
    return this as unknown as SimlockAdminClient;
  }

  // ---- agent-visible operations --------------------------------------------------------------

  getCatalog(input: CatalogGetInput = {}): Promise<CatalogGetOutput> {
    return this.#call("catalog.get", input);
  }

  getStatus(): Promise<StatusGetOutput> {
    return this.#call("status.get", {});
  }

  async requestLease(
    input: LeaseRequestInput,
    options: RequestLeaseOptions = {},
  ): Promise<LeaseGrant> {
    const parsed = this.#parseInput("lease.request", input);
    const requesterId = parsed.requesterId ?? this.principal;
    const { signal, onProgress } = options;

    if (signal?.aborted === true) throw cancelledError();

    const requestPromise = this.#callRaw("lease.request", parsed, onProgress).then(
      (grant) => grant as LeaseGrant,
    );

    if (signal === undefined) return requestPromise;
    return this.#requestLeaseWithAbort(requestPromise, signal, requesterId);
  }

  cancelLease(input: LeaseCancelInput = {}): Promise<LeaseCancelOutput> {
    return this.#call("lease.cancel", input);
  }

  renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    return this.#call("lease.renew", input);
  }

  async releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    const parsed = this.#parseInput("lease.release", input);
    // The daemon suppresses the matching `lease-lost` push to this connection itself (ADR
    // §8) -- see the comment on `SimlockWire`'s `#deliveredLeaseLost`. Nothing to mark here.
    return this.#call("lease.release", parsed);
  }

  listLeases(): Promise<LeaseListOutput> {
    return this.#call("lease.list", {});
  }

  runDoctor(input: DoctorRunInput = {}): Promise<DoctorReport> {
    return this.#call("doctor.run", input);
  }

  resolvePassthrough(input: DriverPassthroughInput): Promise<PassthroughCommand> {
    return this.#call("driver.passthrough", input);
  }

  async execDevice(
    input: DeviceExecInput,
    options: ExecDeviceOptions = {},
  ): Promise<DeviceExecOutput> {
    const payload = await this.#callRaw(
      "device.exec",
      this.#parseInput("device.exec", input),
      undefined,
      options.onOutput,
    );
    return this.#parseOutput("device.exec", payload);
  }

  onLeaseLost(listener: (push: LeaseLostPush) => void): () => void {
    this.#leaseLostListeners.add(listener);
    return () => this.#leaseLostListeners.delete(listener);
  }

  onDeviceUnhealthy(listener: (push: DeviceUnhealthyPush) => void): () => void {
    this.#deviceUnhealthyListeners.add(listener);
    return () => this.#deviceUnhealthyListeners.delete(listener);
  }

  onDeviceRecovered(listener: (push: DeviceRecoveredPush) => void): () => void {
    this.#deviceRecoveredListeners.add(listener);
    return () => this.#deviceRecoveredListeners.delete(listener);
  }

  onConnectionLost(listener: (error: AnySimlockError) => void): () => void {
    this.#connectionLostListeners.add(listener);
    return () => this.#connectionLostListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#wire.close();
  }

  // ---- admin-only operations ------------------------------------------------------------------

  releaseAllLeases(): Promise<LeaseReleaseAllOutput> {
    return this.#call("lease.release-all", {});
  }

  list(input: ListGetInput = {}): Promise<ListGetOutput> {
    return this.#call("list.get", input);
  }

  runCleanup(input: CleanupRunInput = {}): Promise<CleanupRunOutput> {
    return this.#call("cleanup.run", input);
  }

  runNuke(input: NukeRunInput = {}): Promise<NukeReport> {
    return this.#call("nuke.run", input);
  }

  getConfig(): Promise<SimlockConfig> {
    return this.#call("config.get", {});
  }

  stopDaemon(): Promise<DaemonStopOutput> {
    return this.#call("daemon.stop", {});
  }

  replayEvents(input: EventsReplayInput = {}): Promise<EventsReplayOutput> {
    return this.#call("events.replay", input);
  }

  async subscribeEvents(listener: (event: EventPush) => void): Promise<() => Promise<void>> {
    const unsubscribePush = this.#wire.onEvent((payload) => listener(payload as EventPush));
    const result = await this.#call("events.subscribe", {});
    this.#eventSubscriptionId = result.subscriptionId;
    return async () => {
      unsubscribePush();
      if (this.#eventSubscriptionId === undefined) return;
      this.#eventSubscriptionId = undefined;
      await this.#call("events.unsubscribe", {});
    };
  }

  createToken(input: TokenCreateInput): Promise<TokenCreateOutput> {
    return this.#call("token.create", input);
  }

  listTokens(): Promise<TokenListOutput> {
    return this.#call("token.list", {});
  }

  revokeToken(input: TokenRevokeInput): Promise<TokenRevokeOutput> {
    return this.#call("token.revoke", input);
  }

  // ---- abort (ADR §10) ------------------------------------------------------------------------

  /**
   * The four behaviours, all funneled through one function once we know the request was sent
   * and a signal was given:
   *
   * - already resolved by the time abort fires -> `#requestDone` guards the raw promise's own
   *   `.then` from resolving twice; the abort handler itself never runs any cancellation logic
   *   because `#requestDone` is also checked there.
   * - queued / in-flight / not-found are all resolved by `#cancelOnAbort`, driven entirely by
   *   `lease.cancel`'s own three-way result.
   */
  #requestLeaseWithAbort(
    requestPromise: Promise<LeaseGrant>,
    signal: AbortSignal,
    requesterId: string,
  ): Promise<LeaseGrant> {
    return new Promise((resolve, reject) => {
      let requestDone = false;
      let aborted = false;

      const onAbort = (): void => {
        if (requestDone) return; // after the grant resolved (or it already failed) -> ignored.
        aborted = true;
        void this.#cancelOnAbort(requestPromise, requesterId).then(resolve, reject);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      requestPromise.then(
        (grant) => {
          requestDone = true;
          signal.removeEventListener("abort", onAbort);
          if (!aborted) resolve(grant);
        },
        (error: unknown) => {
          requestDone = true;
          signal.removeEventListener("abort", onAbort);
          if (!aborted) reject(error as Error);
        },
      );
    });
  }

  async #cancelOnAbort(
    requestPromise: Promise<LeaseGrant>,
    requesterId: string,
  ): Promise<LeaseGrant> {
    let outcome: LeaseCancelOutput["result"];
    try {
      outcome = (await this.#call("lease.cancel", { requesterId })).result;
    } catch (error: unknown) {
      // Only a connection that actually died mid-cancel falls through to let awaiting
      // `requestPromise` below surface whatever that produces (most likely
      // `DAEMON_CONNECTION_LOST`, a more accurate rejection than a manufactured `CANCELLED`
      // would be here). Every other rejection -- `FORBIDDEN`, `BAD_REQUEST` -- is a real
      // answer from the daemon and must surface as-is: this `catch` used to swallow those
      // unconditionally, which is what let an aborted `requestLease` silently resolve with a
      // real grant instead of `CANCELLED` (see the PR report's B3).
      if (isSimlockError(error) && error.kind === "transport") {
        return requestPromise;
      }
      throw error;
    }

    if (outcome === "not-found") {
      // Either genuinely never existed, or -- per ADR §10's fourth case -- the grant already
      // resolved before the cancel reached the daemon: "after the grant resolved -> ignored".
      // Both cases defer entirely to the original outcome.
      return requestPromise;
    }

    if (outcome === "cancelled") {
      // Queued: the daemon rejects the original waiter; wait for that, then surface CANCELLED
      // regardless of the rejection's own code/message.
      await requestPromise.catch(() => undefined);
      throw cancelledError();
    }

    // "not-cancellable": device work already in flight. Wait for the outcome; a grant that
    // still arrives is abandoned immediately so the caller never holds a lease it walked away
    // from, then CANCELLED is surfaced either way.
    try {
      const grant = await requestPromise;
      await this.#releaseAbandonedGrant(grant);
    } catch {
      // The request failed on its own (e.g. ran out of capacity mid-flight) -- nothing to
      // release, and CANCELLED is still the right thing to tell a caller who asked to abort.
    }
    throw cancelledError();
  }

  async #releaseAbandonedGrant(grant: LeaseGrant): Promise<void> {
    try {
      await this.releaseLease({ leaseId: grant.lease.id });
    } catch {
      // Best-effort: the caller already gets CANCELLED either way. A failed release here means
      // the daemon may still show the lease held -- see the PR report's weak-spots list.
    }
  }

  // ---- pushes -----------------------------------------------------------------------------

  #handleLeaseScopedPush(push: LeaseScopedPush): void {
    switch (push.kind) {
      case "lease-lost":
        for (const listener of this.#leaseLostListeners) {
          listener({ deviceId: push.deviceId, leaseId: push.leaseId, reason: push.reason });
        }
        return;
      case "device-unhealthy":
        for (const listener of this.#deviceUnhealthyListeners) {
          listener({ deviceId: push.deviceId, leaseId: push.leaseId });
        }
        return;
      case "device-recovered":
        for (const listener of this.#deviceRecoveredListeners) {
          listener({ attempts: push.attempts, deviceId: push.deviceId, leaseId: push.leaseId });
        }
        return;
    }
  }

  /**
   * ADR 0004 §3: a dead connection ends no lease, so nothing is synthesized here. The daemon
   * releases nothing on close, so every lease this client was holding is still granted, still
   * counting down its own TTL, and still renewable by whatever connects next -- which is the
   * frontend's decision to make, not this client's (ADR 0003 §10).
   */
  #handleConnectionLost(error: AnySimlockError): void {
    for (const listener of this.#connectionLostListeners) listener(error);
  }

  // ---- call plumbing --------------------------------------------------------------------------

  #parseInput<Name extends OperationName>(
    name: Name,
    input: unknown,
  ): z.infer<(typeof OPERATIONS)[Name]["input"]> {
    const result = OPERATIONS[name].input.safeParse(input);
    if (result.success) return result.data;
    throw new SimlockError(
      "BAD_REQUEST",
      "protocol",
      describeSchemaIssues(result.error.issues),
      {},
    );
  }

  #parseOutput<Name extends OperationName>(
    name: Name,
    payload: unknown,
  ): z.infer<(typeof OPERATIONS)[Name]["output"]> {
    const result = OPERATIONS[name].output.safeParse(payload);
    if (result.success) return result.data;
    throw new SimlockError(
      "BAD_FRAME",
      "protocol",
      `Daemon's ${name} response did not match the contract output schema`,
      {},
    );
  }

  async #call<Name extends OperationName>(
    name: Name,
    input: z.infer<(typeof OPERATIONS)[Name]["input"]>,
  ): Promise<z.infer<(typeof OPERATIONS)[Name]["output"]>> {
    const payload = await this.#callRaw(name, input);
    return this.#parseOutput(name, payload);
  }

  #callRaw(
    name: OperationName,
    input: unknown,
    onProgress?: (progress: LeaseProgress) => void,
    onOutput?: (chunk: DeviceOutputChunk) => void,
  ): Promise<unknown> {
    const parsed = this.#parseInput(name, input);
    return this.#wire.call(name, parsed, onProgress, onOutput).catch((error: unknown) => {
      throw toSimlockError(error);
    });
  }
}

function cancelledError(): SimlockError<"CANCELLED"> {
  return new SimlockError("CANCELLED", "domain", "Lease request was cancelled", {});
}

function toSimlockError(error: unknown): AnySimlockError {
  if (isSimlockError(error)) return error;
  if (error instanceof WireCallError)
    return fromWireError(error.code, error.message, error.details);
  return new SimlockError(
    "DAEMON_CONNECTION_LOST",
    "transport",
    error instanceof Error ? error.message : String(error),
    {},
  );
}
