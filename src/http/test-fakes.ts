import type { Config, DeviceRecord, DeviceRequest, LeaseRecord } from "../core/index.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseCommands,
  QueueControl,
} from "../core/lease-ports.js";
import type { PlatformCatalog } from "../core/driver-catalog.js";
import type { RunningCapacity } from "../core/capacity/index.js";
import type { LeaseGrant, LeaseRequestOptions } from "../core/wait-queue.js";
import type { IdGenerator } from "../ports/index.js";
import type { TokenIdentity } from "./token-store.js";

const gibibyte = 1024 * 1024 * 1024;

/** Shared config fixture; every field `Config` currently declares (see `src/core/config.ts`). */
export function testConfig(overrides: Partial<Config["lease"]> = {}): Config {
  return {
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 4, maxRunning: 4 },
          ios: { maxDevices: 4, maxRunning: 4 },
          maxRunning: 8,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    downloads: { policy: "on-request", acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    http: { enabled: true, host: "127.0.0.1", port: 4700 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    lease: {
      detachedTtlMs: 900_000,
      heartbeatIntervalMs: 5_000,
      heldTtlBackstopMs: 3_600_000,
      ...overrides,
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    stalledTransition: { minimumThresholdMs: 60_000, thresholdMultiplier: 3 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

export function sequenceIdGenerator(prefix = "id"): IdGenerator {
  let next = 0;
  return {
    generate: () => {
      next += 1;
      return `${prefix}-${next}`;
    },
  };
}

export function makeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    createdAt: 0,
    driverData: undefined,
    driverDeviceId: "ABCD-1234",
    id: "dev_1",
    spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    state: "leased",
    ...overrides,
  };
}

export function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    deviceId: "dev_1",
    grantedAt: 1_000,
    id: "lse_1",
    mode: "detached",
    ownerId: "tok_agent",
    requesterId: "tok_agent",
    ttlDeadline: 1_000 + 900_000,
    ...overrides,
  };
}

export function makeGrant(
  overrides: {
    readonly device?: Partial<DeviceRecord>;
    readonly lease?: Partial<LeaseRecord>;
  } = {},
): LeaseGrant {
  return {
    device: makeDevice(overrides.device),
    lease: makeLease(overrides.lease),
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 0,
    },
  };
}

interface PendingRequest {
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  readonly resolve: (grant: LeaseGrant) => void;
  readonly reject: (error: unknown) => void;
}

/** Scriptable `LeaseCommands`: every `request()` call parks until the test resolves/rejects it. */
export class FakeLeaseCommands implements LeaseCommands {
  readonly calls: PendingRequest[] = [];
  readonly releaseCalls: Array<{ readonly leaseId: string; readonly reason: string }> = [];
  readonly renewCalls: Array<{ readonly leaseId: string; readonly ttlMs?: number }> = [];
  renewImpl: (leaseId: string, ttlMs?: number) => Promise<LeaseRecord> = () => {
    throw new Error("renew not scripted");
  };
  releaseImpl: (leaseId: string, reason: string) => Promise<void> = async () => {};

  request(request: DeviceRequest, options: LeaseRequestOptions): Promise<LeaseGrant> {
    return new Promise((resolve, reject) => {
      this.calls.push({ options, reject, request, resolve });
    });
  }

  async release(leaseId: string, reason: "closed" | "explicit" | "killed"): Promise<void> {
    this.releaseCalls.push({ leaseId, reason });
    await this.releaseImpl(leaseId, reason);
  }

  async releaseAll(): Promise<readonly string[]> {
    return [];
  }

  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    this.renewCalls.push({ leaseId, ...(ttlMs === undefined ? {} : { ttlMs }) });
    return this.renewImpl(leaseId, ttlMs);
  }

  async heartbeat(): Promise<LeaseRecord> {
    throw new Error("heartbeat not scripted");
  }
}

/**
 * `FakeLeaseCommands.request` is called synchronously from within `LeaseRequestTracker.submit`,
 * but only once the HTTP layer's own async work (body parsing, auth, validation) reaches the
 * handler -- so a caller driving a request through `app.request()` must pump the microtask
 * queue before `leases.calls[index]` exists. Awaiting the whole response first would deadlock:
 * `submit`'s returned promise doesn't settle until a progress/grant/reject callback fires.
 */
export async function waitForCall(leases: FakeLeaseCommands, index = 0): Promise<void> {
  for (let attempt = 0; attempt < 100 && leases.calls.length <= index; attempt += 1) {
    await Promise.resolve();
  }
  if (leases.calls.length <= index) throw new Error("LeaseCommands.request was never called");
}

export class FakeQueueControl implements QueueControl {
  queueDepth = 0;
  cancelOutcome: "cancelled" | "not-found" | "not-cancellable" = "not-found";
  readonly cancelCalls: string[] = [];

  async detachQueuedProgress(): Promise<void> {}

  async cancelPending(requesterId: string): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    this.cancelCalls.push(requesterId);
    return this.cancelOutcome;
  }
}

export class FakeCapacityReader implements CapacityReader {
  runningCapacity: RunningCapacity = {
    android: { maxRunning: 4, overLimit: false, reserved: 0, running: 0 },
    global: { maxRunning: 8, overLimit: false, reserved: 0, running: 0 },
    ios: { maxRunning: 4, overLimit: false, reserved: 0, running: 0 },
  };

  deviceLimit(): number {
    return 4;
  }
}

export class FakeCatalogReader implements CatalogReader {
  platforms: PlatformCatalog[] = [
    { defaultRuntime: "26.5", models: ["iPhone 17 Pro"], platform: "ios", runtimes: ["26.5"] },
  ];

  async listCatalog(platform?: "ios" | "android"): Promise<readonly PlatformCatalog[]> {
    return this.platforms.filter((entry) => platform === undefined || entry.platform === platform);
  }
}

export class FakeRegistry {
  devices: DeviceRecord[] = [];
  leases: LeaseRecord[] = [];

  // fallow-ignore-next-line unused-class-member -- reached structurally through HttpGatewayDeps.registry.
  get snapshot(): {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  } {
    return { devices: this.devices, leases: this.leases };
  }
}

export class FakeTokenVerifier {
  readonly #identities = new Map<string, TokenIdentity>();

  register(secret: string, identity: TokenIdentity): void {
    this.#identities.set(secret, identity);
  }

  // fallow-ignore-next-line unused-class-member -- reached structurally through HttpGatewayDeps.tokens.
  async verify(secret: string): Promise<TokenIdentity | undefined> {
    return this.#identities.get(secret);
  }
}
