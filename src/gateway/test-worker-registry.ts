import { EventBus, type EventEnvelope } from "../bus/index.js";
import { FakeClock, type Logger } from "../ports/index.js";
import { MemoryDrainStore } from "./drain-store.js";
import { WorkerRegistry } from "./worker-registry.js";

export const RETENTION_MS = 24 * 60 * 60_000;

/** Matches `core/config.ts`'s own default, so a test that does not care about ADR 0005 §15's
 * warning gets a cap no fixture's `ttlMs` ever comes near. */
const DEFAULT_LEASE_MAX_TTL_MS = 4 * 60 * 60_000;

/** Matches `service.test.ts`'s `principal: "gw:instance-1"` -- ADR 0005 §14/§27's own-lease
 * prefix is that principal plus a trailing `:`. */
export const GATEWAY_REQUESTER_PREFIX = "gw:instance-1:";

export function registry(
  options: {
    readonly drainStore?: MemoryDrainStore;
    /** Omit to get the default fixture prefix; pass `null` explicitly (H3) to build a registry
     * with no `gatewayRequesterPrefix` at all, the way `dispatcher.test.ts`'s harness does. */
    readonly gatewayRequesterPrefix?: string | null;
    /** ADR 0005 §15's own cap. Defaults to `core/config.ts`'s own default so a test that never
     * reports a worker `lease.maxTtlMs` cannot accidentally trip the new warning. */
    readonly leaseMaxTtlMs?: number;
    readonly logger?: Logger;
  } = {},
) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const events: EventEnvelope[] = [];
  eventBus.subscribeAll((envelope) => events.push(envelope));
  const gatewayRequesterPrefix =
    options.gatewayRequesterPrefix === null
      ? undefined
      : (options.gatewayRequesterPrefix ?? GATEWAY_REQUESTER_PREFIX);
  const workers = new WorkerRegistry({
    clock,
    eventBus,
    leaseMaxTtlMs: options.leaseMaxTtlMs ?? DEFAULT_LEASE_MAX_TTL_MS,
    retentionMs: RETENTION_MS,
    ...(gatewayRequesterPrefix === undefined ? {} : { gatewayRequesterPrefix }),
    ...(options.drainStore === undefined ? {} : { drainStore: options.drainStore }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { clock, events, workers };
}
