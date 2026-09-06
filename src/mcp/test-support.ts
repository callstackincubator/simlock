/**
 * A scripted `SimlockClient` double for MCP's own unit tests. MCP no longer talks to the
 * daemon directly (PR 4 moved it onto `simlock/client`), so its tests script the typed
 * client's surface instead of a raw `DaemonConnection`/`IpcConnection`.
 */
import {
  SimlockError,
  type AnySimlockError,
  type CatalogGetInput,
  type CatalogGetOutput,
  type DeviceRecoveredPush,
  type DeviceUnhealthyPush,
  type DoctorReport,
  type DoctorRunInput,
  type DeviceExecInput,
  type DeviceExecOutput,
  type DriverPassthroughInput,
  type LeaseCancelInput,
  type LeaseCancelOutput,
  type LeaseGrant,
  type LeaseListOutput,
  type LeaseLostPush,
  type LeaseReleaseInput,
  type LeaseReleaseOutput,
  type LeaseRenewInput,
  type LeaseRecord,
  type LeaseRequestInput,
  type PassthroughCommand,
  type RequestLeaseOptions,
  type SimlockClient,
  type StatusGetOutput,
} from "../client/index.js";
import type { Role } from "../contract/index.js";

export interface FakeSimlockClientOptions {
  readonly daemonVersion?: string;
  readonly principal?: string;
  readonly role?: Role;
}

function notStubbed(method: string): () => never {
  return () => {
    throw new Error(`FakeSimlockClient.${method} was not stubbed for this test`);
  };
}

/** Records every call and lets a test script each method's response and fire pushes on demand. */
export class FakeSimlockClient implements SimlockClient {
  readonly principal: string;
  readonly role: Role;
  readonly daemonVersion: string;
  closeCalls = 0;
  readonly calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  /** Set by `close()`. Every operation after it rejects, the way `SimlockWire` does once the
   * connection is gone (ADR 0003 §10) -- a fake that stayed usable would let a test pass on a
   * dead wire. */
  #dead = false;

  getCatalogImpl: (input: CatalogGetInput) => Promise<CatalogGetOutput> = notStubbed("getCatalog");
  getStatusImpl: () => Promise<StatusGetOutput> = notStubbed("getStatus");
  requestLeaseImpl: (
    input: LeaseRequestInput,
    options: RequestLeaseOptions,
  ) => Promise<LeaseGrant> = notStubbed("requestLease");
  cancelLeaseImpl: (input: LeaseCancelInput) => Promise<LeaseCancelOutput> =
    notStubbed("cancelLease");
  renewLeaseImpl: (input: LeaseRenewInput) => Promise<LeaseRecord> = notStubbed("renewLease");
  releaseLeaseImpl: (input: LeaseReleaseInput) => Promise<LeaseReleaseOutput> =
    notStubbed("releaseLease");
  listLeasesImpl: () => Promise<LeaseListOutput> = notStubbed("listLeases");
  runDoctorImpl: (input: DoctorRunInput) => Promise<DoctorReport> = notStubbed("runDoctor");
  resolvePassthroughImpl: (input: DriverPassthroughInput) => Promise<PassthroughCommand> =
    notStubbed("resolvePassthrough");
  execDeviceImpl: (input: DeviceExecInput) => Promise<DeviceExecOutput> = notStubbed("execDevice");

  readonly #leaseLostListeners = new Set<(push: LeaseLostPush) => void>();
  readonly #deviceUnhealthyListeners = new Set<(push: DeviceUnhealthyPush) => void>();
  readonly #deviceRecoveredListeners = new Set<(push: DeviceRecoveredPush) => void>();
  readonly #connectionLostListeners = new Set<(error: AnySimlockError) => void>();

  constructor(options: FakeSimlockClientOptions = {}) {
    this.principal = options.principal ?? "mcp-test";
    this.role = options.role ?? "agent";
    this.daemonVersion = options.daemonVersion ?? "test";
  }

  getCatalog(input: CatalogGetInput = {}): Promise<CatalogGetOutput> {
    this.calls.push({ input, method: "getCatalog" });
    return this.#dead ? this.#deadConnection() : this.getCatalogImpl(input);
  }

  getStatus(): Promise<StatusGetOutput> {
    this.calls.push({ input: undefined, method: "getStatus" });
    return this.#dead ? this.#deadConnection() : this.getStatusImpl();
  }

  requestLease(input: LeaseRequestInput, options: RequestLeaseOptions = {}): Promise<LeaseGrant> {
    this.calls.push({ input, method: "requestLease" });
    return this.#dead ? this.#deadConnection() : this.requestLeaseImpl(input, options);
  }

  cancelLease(input: LeaseCancelInput = {}): Promise<LeaseCancelOutput> {
    this.calls.push({ input, method: "cancelLease" });
    return this.#dead ? this.#deadConnection() : this.cancelLeaseImpl(input);
  }

  renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    this.calls.push({ input, method: "renewLease" });
    return this.#dead ? this.#deadConnection() : this.renewLeaseImpl(input);
  }

  releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    this.calls.push({ input, method: "releaseLease" });
    return this.#dead ? this.#deadConnection() : this.releaseLeaseImpl(input);
  }

  listLeases(): Promise<LeaseListOutput> {
    this.calls.push({ input: undefined, method: "listLeases" });
    return this.#dead ? this.#deadConnection() : this.listLeasesImpl();
  }

  runDoctor(input: DoctorRunInput = {}): Promise<DoctorReport> {
    this.calls.push({ input, method: "runDoctor" });
    return this.#dead ? this.#deadConnection() : this.runDoctorImpl(input);
  }

  resolvePassthrough(input: DriverPassthroughInput): Promise<PassthroughCommand> {
    this.calls.push({ input, method: "resolvePassthrough" });
    return this.#dead ? this.#deadConnection() : this.resolvePassthroughImpl(input);
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP exposes no device.exec tool of its own.
  execDevice(input: DeviceExecInput): Promise<DeviceExecOutput> {
    this.calls.push({ input, method: "execDevice" });
    return this.#dead ? this.#deadConnection() : this.execDeviceImpl(input);
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

  emitLeaseLost(push: LeaseLostPush): void {
    for (const listener of this.#leaseLostListeners) listener(push);
  }

  emitDeviceUnhealthy(push: DeviceUnhealthyPush): void {
    for (const listener of this.#deviceUnhealthyListeners) listener(push);
  }

  emitDeviceRecovered(push: DeviceRecoveredPush): void {
    for (const listener of this.#deviceRecoveredListeners) listener(push);
  }

  /** Simulates the connection dying (a crash, not `close()`) without marking this fake closed. */
  emitConnectionLost(
    error: AnySimlockError = new SimlockError(
      "DAEMON_CONNECTION_LOST",
      "transport",
      "Daemon connection lost",
      {},
    ),
  ): void {
    for (const listener of this.#connectionLostListeners) listener(error);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#dead = true;
    this.emitConnectionLost(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Client closed the connection", {}),
    );
  }

  /** The rejection every operation gets once this connection is closed. */
  #deadConnection<T>(): Promise<T> {
    return Promise.reject(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Connection is closed", {}),
    );
  }
}

export function sampleGrant(overrides: { readonly leaseId?: string } = {}): LeaseGrant {
  const leaseId = overrides.leaseId ?? "lease-1";
  return {
    device: {
      driverDeviceId: "SIM-1",
      id: "device-1",
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    },
    environment: {},
    lease: {
      deviceId: "device-1",
      grantedAt: 0,
      id: leaseId,
      ownerId: "mcp-test",
      requesterId: "mcp-test",
      lastRenewedAt: 0,
      ttlMs: 60_000,
      ttlDeadline: 12_345,
    },
    timing: {
      estimatedBootMs: 3,
      estimatedProvisionMs: 2,
      estimatedReadyMs: 6,
      estimatedReclaimMs: 1,
    },
  };
}
