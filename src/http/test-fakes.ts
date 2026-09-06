import type { Config, DeviceRecord, LeaseRecord } from "../core/index.js";
import type { LeaseGrant } from "../core/wait-queue.js";
import type { OperationName } from "../contract/index.js";
import type { DispatchSession } from "../daemon/dispatcher.js";
import type { IdGenerator } from "../ports/index.js";
import type { TokenIdentity } from "./token-store.js";

const gibibyte = 1024 * 1024 * 1024;

/** Shared config fixture; every field `Config` currently declares (see `src/core/config.ts`). */
export function testConfig(overrides: Partial<Config["lease"]> = {}): Config {
  return {
    mode: "worker",
    gateway: { disconnectedRetentionMs: 24 * 60 * 60_000 },
    drivers: {},
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
    exec: { timeoutMs: 600_000 },
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
      defaultTtlMs: 900_000,
      maxTtlMs: 14_400_000,
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
    ownerId: "tok_agent",
    requesterId: "tok_agent",
    lastRenewedAt: 1_000,
    ttlMs: 60_000,
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
    environment: {},
    lease: makeLease(overrides.lease),
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 0,
    },
  };
}

/**
 * A scripted call this fake's `dispatch()` recorded and did not resolve synchronously via
 * `handlers` -- `resolve`/`reject` settle the promise `dispatch()` returned, and `session` is
 * exposed so a test can drive a `lease.request` call's `onProgress` override the same way it
 * used to reach into `FakeLeaseCommands.calls[i].options.onProgress`.
 */
export interface FakeDispatchCall {
  readonly operation: OperationName;
  readonly input: unknown;
  readonly session: DispatchSession;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Test double for `HttpDispatch` (`src/http/dispatcher-session.ts`). Deliberately does not
 * reproduce the real `Dispatcher`'s input parsing, role check, `authorize` hook, or startup
 * parking -- those are covered against the real thing in `daemon/dispatcher.test.ts` and
 * `daemon/server.test.ts`. This fake exists to let HTTP's own routing/serialization tests
 * (`app.test.ts`, `tracker.test.ts`) script an operation's answer without standing up a full
 * `LeaseEngine`/`Registry`/`CleanupReaper`.
 *
 * Two ways to script an answer: register a synchronous `handlers[operation]` for the common
 * "this call always answers the same way" case, or -- for `lease.request`'s progress-then-grant
 * flow, which needs to drive `session.onProgress` before settling -- leave it unregistered and
 * resolve/reject the pushed `FakeDispatchCall` from `calls` once the test is ready.
 */
export class FakeDispatcher {
  readonly calls: FakeDispatchCall[] = [];
  readonly handlers: Partial<
    Record<OperationName, (input: never, session: DispatchSession) => unknown>
  > = {};

  dispatch(operation: OperationName, input: unknown, session: DispatchSession): Promise<unknown> {
    const handler = this.handlers[operation];
    if (handler !== undefined) {
      const settled = Promise.resolve(handler(input as never, session));
      this.calls.push({
        input,
        operation,
        reject: () => {},
        resolve: () => {},
        session,
      });
      return settled;
    }
    return new Promise((resolve, reject) => {
      this.calls.push({ input, operation, reject, resolve, session });
    });
  }
}

/**
 * `FakeDispatcher.dispatch` is called synchronously from within `LeaseRequestTracker.submit`,
 * but only once the HTTP layer's own async work (body parsing, auth, validation) reaches the
 * handler -- so a caller driving a request through `app.request()` must pump the microtask
 * queue before `dispatcher.calls[index]` exists. Awaiting the whole response first would
 * deadlock: `submit`'s returned promise doesn't settle until a progress/grant/reject callback
 * fires.
 */
export async function waitForDispatch(
  dispatcher: FakeDispatcher,
  operation: OperationName,
  index = 0,
): Promise<FakeDispatchCall> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matches = dispatcher.calls.filter((call) => call.operation === operation);
    if (matches.length > index) return matches[index] as FakeDispatchCall;
    await Promise.resolve();
  }
  throw new Error(`${operation} was never dispatched`);
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
