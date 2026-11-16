import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  MemoryUplinkTransport,
  type Logger,
  type UplinkAuthOutcome,
  type UplinkAuthResult,
} from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { GatewayService } from "./service.js";
import { ScriptedWorkerClient } from "./test-support.js";

export const RETENTION_MS = 24 * 60 * 60_000;

export const REFRESH_MS = 30_000;

const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

export class RecordingLogger implements Logger {
  readonly warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];

  debug(): void {}
  info(): void {}
  warn(message: string, fields?: Record<string, unknown>): void {
    this.warnings.push(fields === undefined ? { message } : { fields, message });
  }
  readonly errors: string[] = [];
  error(message: string): void {
    this.errors.push(message);
  }
  child(): Logger {
    return this;
  }
}

export function fleet(
  options: {
    readonly authenticate?: (
      credential: string | undefined,
      workerId: string | undefined,
    ) => UplinkAuthOutcome | UplinkAuthResult;
    readonly leaseMaxTtlMs?: number;
    readonly logger?: Logger;
    readonly refreshIntervalMs?: number;
    /** why: leaves `connect` unset so the gateway builds its real client over the uplink. */
    readonly realConnect?: boolean;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const transport = new MemoryUplinkTransport();
  const clients: ScriptedWorkerClient[] = [];
  const connectState = { hangNext: false };
  const service = new GatewayService({
    authenticate: async (credential, workerId) =>
      options.authenticate?.(credential, workerId) ?? "accept",
    clock,
    ...(options.realConnect === true
      ? {}
      : {
          connect: async () => {
            if (connectState.hangNext) {
              connectState.hangNext = false;
              return new Promise<never>(() => {});
            }
            const client = clients.at(-1);
            if (client === undefined)
              throw new Error("no scripted worker was queued for this uplink");
            return client.asClient();
          },
        }),
    drainStore: new MemoryDrainStore(),
    eventBus,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? DEFAULT_LEASE_MAX_TTL_MS,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    principal: "gw:instance-1",
    refreshIntervalMs: options.refreshIntervalMs ?? REFRESH_MS,
    retentionMs: RETENTION_MS,
    uplinks: transport,
  });
  return {
    clients,
    clock,
    eventBus,
    events,
    service,
    transport,
    join: async (
      workerId: string,
      client: ScriptedWorkerClient,
      label?: string,
      token = "join-secret",
    ) => {
      clients.push(client);
      return transport.connect({
        token,
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
    joinSilent: async (workerId: string, label?: string) => {
      connectState.hangNext = true;
      return transport.connect({
        token: "join-secret",
        url: "ws://gateway.test",
        workerId,
        ...(label === undefined ? {} : { label }),
      });
    },
  };
}

export function eventNames(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.event);
}
