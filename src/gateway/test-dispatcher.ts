import { createAlerts } from "../alerts/index.js";
import { EventBus } from "../bus/index.js";
import type { AlertDestination } from "../core/index.js";
import { testConfig } from "../core/testing.js";
import type { EventHistoryHandle } from "../history/index.js";
import { ringEventHistory } from "../history/testing.js";
import { DispatchError, type DispatchSession } from "../daemon/dispatch.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink, type WebhookPoster } from "../ports/index.js";
import { FakeWebhookPoster } from "../ports/testing.js";
import type { TokenOperations } from "../auth/index.js";
import { GatewayDispatcher, type GatewayDispatcherOptions } from "./dispatcher.js";
import { MemoryDrainStore } from "./drain-store.js";
import { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import type { WorkerDirectory, WorkerDispatchTarget } from "./fleet-ports.js";
import { FleetLeaseIndex } from "./lease-index.js";
import { createRoutingPolicy } from "./routing.js";
import { ScriptedWorkerClient } from "./test-support.js";
import { WorkerRegistry } from "./worker-registry.js";

export const gatewayConfig = testConfig(
  {
    capacity: { strategy: "fixed", config: { maxRunning: 4 } },
    lease: { maxTtlMs: 3_600_000 },
  },
  "gateway",
);

class FakeTokens implements TokenOperations {
  constructor(private readonly records: readonly { id: string; label?: string }[] = []) {}

  readonly created: string[] = [];
  readonly revoked: string[] = [];

  async create(role: "agent" | "operator" | "worker", label?: string) {
    this.created.push(role);
    return {
      record: {
        createdAt: 1,
        hash: "unused",
        id: "tok_1",
        role,
        ...(label === undefined ? {} : { label }),
      },
      secret: "slk_secret",
    };
  }

  async verify(): Promise<undefined> {
    return undefined;
  }

  async list() {
    return [
      { createdAt: 1, hash: "unused", id: "tok_1", role: "worker" as const },
      ...this.records.map((record) => ({
        createdAt: 1,
        hash: "unused",
        role: "agent" as const,
        ...record,
      })),
    ];
  }

  async revoke(id: string) {
    this.revoked.push(id);
    return id === "tok_1";
  }
}

export const GATEWAY_REQUESTER_PREFIX = "gw:instance-1:";

export const GATEWAY_HOST = { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] };

class FakeDirectory implements WorkerDirectory {
  readonly clients = new Map<string, ScriptedWorkerClient>();
  readonly refreshCalls: string[] = [];
  /** why: the workers whose refresh asked for the catalog, baselines and config read as well. */
  readonly catalogRefreshCalls: string[] = [];
  /** why: what a worker reports when the gateway reads its view again; none leaves the view as it is; it may take a tick, as a real read does. */
  readonly onRefresh = new Map<string, () => void | Promise<void>>();

  add(workerId: string, client: ScriptedWorkerClient): void {
    this.clients.set(workerId, client);
  }

  target(workerId: string): WorkerDispatchTarget | undefined {
    const client = this.clients.get(workerId);
    if (client === undefined) return undefined;
    return {
      client: () => client.asClient(),
      reachable: true,
      refresh: async (options) => {
        this.refreshCalls.push(workerId);
        if (options?.includeCatalog === true) this.catalogRefreshCalls.push(workerId);
        await this.onRefresh.get(workerId)?.();
      },
      workerId,
    };
  }
}

// why: the gateway's own update coordinator, scripted.
class ScriptedUpdate {
  readonly requests: unknown[] = [];
  progress: ReturnType<GatewayDispatcherOptions["update"]["state"]> = {
    lastUpdateFailure: null,
    latestVersion: null,
    update: null,
  };

  async request(input: unknown) {
    this.requests.push(input);
    return { ...this.progress, resolved: "0.4.0", started: true, upToDate: false };
  }

  state() {
    return this.progress;
  }
}

export function harness(
  options: {
    readonly eventHistory?: Pick<EventHistoryHandle, "replay" | "replayPage" | "status">;
    readonly historyPath?: string;
    readonly tokenRecords?: readonly { id: string; label?: string }[];
    readonly withoutTokens?: boolean;
    readonly http?: (typeof gatewayConfig)["http"];
    readonly health?: "starting" | "running" | "failed";
    readonly load?: ConstructorParameters<typeof GatewayDispatcher>[0]["load"];
    /** why: real alerts over a fake poster, wired as `testDestination`; none leaves the option out. */
    readonly alertDestinations?: readonly AlertDestination[];
    /** why: replaces the fake poster behind `alertDestinations`, for a case that needs a real connection. */
    readonly webhookPoster?: WebhookPoster;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const logSink = new MemoryLogSink();
  const eventBus = new EventBus(clock);
  const workers = new WorkerRegistry({
    clock,
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: gatewayConfig.lease.maxTtlMs,
    retentionMs: 24 * 60 * 60_000,
  });
  const tokens = new FakeTokens(options.tokenRecords);
  const closedUplinkTokens: string[] = [];
  const directory = new FakeDirectory();
  const leaseIndex = new FleetLeaseIndex(GATEWAY_REQUESTER_PREFIX);
  const coordinator = new FleetLeaseCoordinator({
    clock,
    directory,
    describeFailure: (error) => ({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }),
    leaseRequestLimits: { maxRecords: 10_000, retentionMs: 600_000 },
    maxPerRequester: { android: 1, ios: 1 },
    eventBus,
    execTimeoutMs: gatewayConfig.gateway.execTimeoutMs,
    leaseRequestTimeoutMs: gatewayConfig.gateway.leaseRequestTimeoutMs,
    idGenerator: {
      generate: (() => {
        let next = 1;
        return () => `${next++}`;
      })(),
    },
    leaseIndex,
    routing: createRoutingPolicy("warm-then-free"),
    views: workers,
  });
  const poster = new FakeWebhookPoster();
  const alerts =
    options.alertDestinations === undefined
      ? undefined
      : createAlerts({
          clock,
          destinations: options.alertDestinations,
          eventBus,
          idGenerator: { generate: () => "sample-id" },
          logger: new JsonLinesLogger({ clock, module: "alerts", sink: logSink }),
          poster: options.webhookPoster ?? poster,
          version: "9.9.9",
          workerLabel: () => undefined,
        });
  const update = new ScriptedUpdate();
  const dispatcher = new GatewayDispatcher({
    awaitReady: async () => {},
    latestVersion: () => null,
    update,
    clock,
    closeUplinksForToken: async (tokenId) => {
      closedUplinkTokens.push(tokenId);
    },
    config: options.http === undefined ? gatewayConfig : { ...gatewayConfig, http: options.http },
    coordinator,
    directory,
    eventHistory: options.eventHistory ?? ringEventHistory(eventBus),
    ...(options.historyPath === undefined ? {} : { historyPath: options.historyPath }),
    health: () => options.health ?? "running",
    version: "0.0.0-test",
    host: GATEWAY_HOST,
    ...(options.load === undefined ? {} : { load: options.load }),
    leaseIndex,
    errorCode: (error) => (error instanceof DispatchError ? error.code : undefined),
    logger: new JsonLinesLogger({ clock, module: "gateway", sink: logSink }),
    ...(alerts === undefined ? {} : { testDestination: (name) => alerts.test(name) }),
    ...(options.withoutTokens === true ? {} : { tokens }),
    workers,
  });
  return {
    alerts,
    poster,
    clock,
    logSink,
    closedUplinkTokens,
    coordinator,
    directory,
    dispatcher,
    eventBus,
    leaseIndex,
    tokens,
    update,
    workers,
  };
}

export function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => "sub_1",
    principal: "operator-1",
    role: "admin",
    via: "socket",
    ...overrides,
  };
}
