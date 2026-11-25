import { OPERATIONS, SimlockError } from "../contract/index.js";
import type { SimlockWire } from "./wire.js";
import type { RelayClientMethods, SimlockAdminClient, SimlockClient } from "./client-api.js";
import { toSimlockError } from "./client-errors.js";
import type { DaemonStopOutput, DaemonUpdateInput, DaemonUpdateOutput } from "./types.js";

/**
 * why: ADR §6's escape hatch on the client side. A mismatch leaves the connection open so an admin can still send the
 * two frozen calls, `stopDaemon()` and `updateDaemon()` (the daemon answers them at any protocol version, ahead of its
 * mismatch gate); everything else rejects with the captured `PROTOCOL_VERSION_UNSUPPORTED` error without being sent,
 * and `close()` still works. `role` reflects which entry point the caller used and `principal` what it supplied,
 * because the daemon resolves them but the failed `hello` never reports them back; the daemon's own role check on the
 * credential it already verified is what gates the two calls.
 */
export function buildDegradedClient(
  wire: SimlockWire,
  error: SimlockError<"PROTOCOL_VERSION_UNSUPPORTED">,
  principal: string,
  admin: boolean,
): SimlockClient | SimlockAdminClient {
  const rejected = <T>(): Promise<T> => Promise.reject(error);
  const client: SimlockAdminClient & RelayClientMethods = {
    principal,
    role: admin ? "admin" : "agent",
    daemonVersion: error.details.daemonVersion,

    getCatalog: () => rejected(),
    getStatus: () => rejected(),
    identity: () => rejected(),
    listComponents: () => rejected(),
    requestLease: () => rejected(),
    cancelLease: () => rejected(),
    renewLease: () => rejected(),
    releaseLease: () => rejected(),
    releaseRunLeases: () => rejected(),
    listLeases: () => rejected(),
    runDoctor: () => rejected(),
    resolvePassthrough: () => rejected(),
    exec: () => rejected(),
    rotate: () => rejected(),

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
    forgetWarmKind: () => rejected(),
    getConfig: () => rejected(),
    stopDaemon: () => frozenCall(wire, "daemon.stop", {}),
    updateDaemon: (input = {}) => frozenCall(wire, "daemon.update", input),
    replayEvents: () => rejected(),
    usage: () => rejected(),
    subscribeEvents: () => rejected(),
    createToken: () => rejected(),
    listTokens: () => rejected(),
    revokeToken: () => rejected(),
    listWorkers: () => rejected(),
    drainWorker: () => rejected(),
    undrainWorker: () => rejected(),
    removeWorker: () => rejected(),
    updateWorker: () => rejected(),
    testAlertDestination: () => rejected(),
    installComponent: () => rejected(),
    installComponentOnWorkers: () => rejected(),
    makeSeed: () => rejected(),
    removeComponent: () => rejected(),
    saveBaseline: () => rejected(),
    listBaselines: () => rejected(),
    removeBaseline: () => rejected(),
    addDevice: () => rejected(),
    removeDevice: () => rejected(),
    relayRequest: () => rejected(),
    openChannel: () => rejected(),
    relayCancel: () => rejected(),
  };
  return client;
}

// why: the two frozen calls (`daemon.stop`, `daemon.update`) are the only ones a degraded client sends, and the daemon answers them at any protocol version.
function frozenCall(
  wire: SimlockWire,
  operation: "daemon.stop",
  input: Record<string, never>,
): Promise<DaemonStopOutput>;
function frozenCall(
  wire: SimlockWire,
  operation: "daemon.update",
  input: DaemonUpdateInput,
): Promise<DaemonUpdateOutput>;
function frozenCall(
  wire: SimlockWire,
  operation: "daemon.stop" | "daemon.update",
  input: unknown,
): Promise<unknown> {
  return wire.call(operation, input).then(
    (payload) => {
      const result = OPERATIONS[operation].output.safeParse(payload);
      if (!result.success) {
        throw new SimlockError(
          "BAD_FRAME",
          "protocol",
          `Daemon's ${operation} response did not match the contract output schema`,
          {},
        );
      }
      return result.data;
    },
    (callError: unknown) => {
      throw toSimlockError(callError);
    },
  );
}
