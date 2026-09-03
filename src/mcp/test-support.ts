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
  type LeaseCancelInput,
  type LeaseCancelOutput,
  type LeaseGrant,
  type LeaseHeartbeatOutput,
  type LeaseListOutput,
  type LeaseLostPush,
  type LeaseReleaseInput,
  type LeaseReleaseOutput,
  type LeaseRenewInput,
  type LeaseRecord,
  type LeaseRequestInput,
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
  heartbeatImpl: () => Promise<LeaseHeartbeatOutput> = notStubbed("heartbeat");
  runDoctorImpl: (input: DoctorRunInput) => Promise<DoctorReport> = notStubbed("runDoctor");

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
    return this.getCatalogImpl(input);
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP itself never calls status.get.
  getStatus(): Promise<StatusGetOutput> {
    this.calls.push({ input: undefined, method: "getStatus" });
    return this.getStatusImpl();
  }

  requestLease(input: LeaseRequestInput, options: RequestLeaseOptions = {}): Promise<LeaseGrant> {
    this.calls.push({ input, method: "requestLease" });
    return this.requestLeaseImpl(input, options);
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP itself never calls lease.cancel.
  cancelLease(input: LeaseCancelInput = {}): Promise<LeaseCancelOutput> {
    this.calls.push({ input, method: "cancelLease" });
    return this.cancelLeaseImpl(input);
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP itself never calls lease.renew.
  renewLease(input: LeaseRenewInput): Promise<LeaseRecord> {
    this.calls.push({ input, method: "renewLease" });
    return this.renewLeaseImpl(input);
  }

  releaseLease(input: LeaseReleaseInput): Promise<LeaseReleaseOutput> {
    this.calls.push({ input, method: "releaseLease" });
    return this.releaseLeaseImpl(input);
  }

  listLeases(): Promise<LeaseListOutput> {
    this.calls.push({ input: undefined, method: "listLeases" });
    return this.listLeasesImpl();
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP itself never calls lease.heartbeat (the client handles it internally).
  heartbeat(): Promise<LeaseHeartbeatOutput> {
    this.calls.push({ input: undefined, method: "heartbeat" });
    return this.heartbeatImpl();
  }

  // fallow-ignore-next-line unused-class-member -- part of the SimlockClient interface this fake implements; MCP itself never calls doctor.run.
  runDoctor(input: DoctorRunInput = {}): Promise<DoctorReport> {
    this.calls.push({ input, method: "runDoctor" });
    return this.runDoctorImpl(input);
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
    this.emitConnectionLost(
      new SimlockError("DAEMON_CONNECTION_LOST", "transport", "Client closed the connection", {}),
    );
  }
}

export function sampleGrant(overrides: { readonly leaseId?: string } = {}): LeaseGrant {
  const leaseId = overrides.leaseId ?? "lease-1";
  return {
    device: {
      createdAt: 0,
      driverData: null,
      driverDeviceId: "SIM-1",
      id: "device-1",
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      state: "leased",
    },
    lease: {
      deviceId: "device-1",
      grantedAt: 0,
      id: leaseId,
      mode: "held",
      ownerId: "mcp-test",
      requesterId: "mcp-test",
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
