import type { EventBus, WorkerRejectedReason } from "../bus/index.js";
import type {
  AcceptedUplink,
  Clock,
  Logger,
  TimerHandle,
  UplinkAuthResult,
  UplinkListener,
  UplinkListenerFactory,
} from "../ports/index.js";
import { WORKER_VIEW_REFRESH_INTERVAL_MS } from "../contract/index.js";
import { NoopLogger, uplinkOutcome } from "../ports/index.js";
import type { DrainStore } from "./drain-store.js";
import { createLink } from "../link/index.js";
import { WorkerLink, type WorkerClientFactory } from "./worker-link.js";
import { WorkerRegistry } from "./worker-registry.js";

/**
 * why: How often the gateway refreshes every worker view and sweeps expired ones, absent an
 * override. ADR 0005 §7 asks for "a slow periodic tick as a backstop" -- slow because the
 * uplink's event stream is the real signal and this only catches what it missed (an event lost
 * to a refresh that failed, a worker whose `events.subscribe` was refused). Thirty seconds is
 * far below the shortest interesting lease TTL and far above anything that would make a fleet's
 * worth of `status.get` calls noticeable.
 */
const DEFAULT_WORKER_REFRESH_INTERVAL_MS = WORKER_VIEW_REFRESH_INTERVAL_MS;

/**
 * P-2: how long a coalescing window for repeated `worker.rejected` refusals stays open.
 * `GET /v1/uplink` needs no credential to reach `authenticate` (P3), so a loop of refused dials
 * -- deliberate or a genuinely misconfigured worker retrying fast -- would otherwise emit one
 * `worker.rejected` per attempt, and the event bus's ring buffer is bounded by count, not bytes:
 * enough of them evicts every other fact an operator comes to `simlock events` for. One second
 * is short enough that a legitimate operator watching `simlock events --follow` still sees a
 * refusal essentially the moment it happens, and long enough to collapse a tight retry loop
 * (a worker's redial backoff starts at 1 s, https://github.com/callstackincubator/simlock/blob/main/src/gateway/AGENTS.md) to about one
 * event per second regardless of how fast the dials themselves arrive.
 */
export const REJECTION_COALESCE_WINDOW_MS = 1_000;

/**
 * why: P-2: bounds `#recentRejections` itself. Coalescing keys on the claimed worker id, which is
 * attacker-controlled (P3) -- without a cap, a flood that varies its claimed id every dial would
 * trade one unbounded structure (the event bus's ring buffer) for another (this map) rather than
 * actually fixing anything. Evicting the oldest window on overflow means a wide-enough flood
 * degrades back to "one event per refusal" for the ids that get evicted, which is only ever as
 * bad as this fix's baseline (pre-P-2) behavior -- never worse.
 */
const MAX_TRACKED_REJECTION_WINDOWS = 1_000;

export interface GatewayServiceOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly uplinks: UplinkListenerFactory;
  /**
   * why: injected rather than taking a token store, so this module never learns what a token
   * *is* -- except its id, which an `accept` may carry (`UplinkAuthResult`) so
   * `closeLinksForToken` (C-2) can later find the link it opened. Gets the claimed worker id,
   * because a join token is pinned to one worker (`worker-mismatch` otherwise).
   */
  readonly authenticate: (
    credential: string | undefined,
    workerId: string | undefined,
  ) => Promise<UplinkAuthResult>;
  readonly retentionMs: number;
  readonly leaseMaxTtlMs: number;
  readonly drainStore?: DrainStore;
  readonly principal: string;
  readonly logger?: Logger;
  readonly refreshIntervalMs?: number;
  readonly connect?: WorkerClientFactory;
}

export class GatewayService {
  readonly #registry: WorkerRegistry;
  readonly #links = new Map<string, WorkerLink>();
  readonly #logger: Logger;
  readonly #refreshIntervalMs: number;
  #listener: UplinkListener | undefined;
  #tick: TimerHandle | undefined;
  #stopped = false;
  /** why: P-2: open coalescing windows for `worker.rejected`, keyed by `${reason}:${claimed id}`.
   * Insertion order is what makes the overflow eviction in `#recordRejection` an LRU-ish
   * "drop the oldest key" rather than an arbitrary one -- `Map` preserves it. */
  readonly #recentRejections = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly options: GatewayServiceOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_WORKER_REFRESH_INTERVAL_MS;
    this.#registry = new WorkerRegistry({
      clock: options.clock,
      eventBus: options.eventBus,
      gatewayRequesterPrefix: `${options.principal}:`,
      leaseMaxTtlMs: options.leaseMaxTtlMs,
      logger: this.#logger,
      retentionMs: options.retentionMs,
      ...(options.drainStore === undefined ? {} : { drainStore: options.drainStore }),
    });
  }

  get workers(): WorkerRegistry {
    return this.#registry;
  }

  target(workerId: string): WorkerLink | undefined {
    return this.#links.get(workerId);
  }

  async closeLinksForToken(tokenId: string): Promise<void> {
    const matches = [...this.#links.values()].filter((link) => link.tokenId === tokenId);
    await Promise.all(matches.map((link) => link.close()));
  }

  async start(): Promise<void> {
    // why: Before the listener, not after: a worker that reconnects in the first millisecond must
    // find its drain state already restored, or it would be dispatched to once (#118) before
    // the flag landed.
    await this.#registry.load();
    this.#listener = await this.options.uplinks.listen({
      accept: (uplink) => this.#accept(uplink),
      authenticate: async (credential, claimed) => {
        const result = await this.options.authenticate(credential, claimed.workerId);
        const outcome = uplinkOutcome(result);
        // why: ADR 0005 §22's fleet audit trail includes the joins that failed: a revoked token
        // retrying at its backoff cap is invisible on the gateway otherwise. Which refusal it
        // was travels with the fact. `workerId` and `label` are only what the dial *claimed* in
        // its headers -- a refused uplink proves no identity, but the claim is still worth an
        // operator's while.
        // P-2: coalesced rather than emitted one-per-dial -- see `#recordRejection`.
        if (outcome !== "accept") this.#recordRejection(outcome, claimed.workerId, claimed.label);
        return result;
      },
    });
    this.#scheduleTick();
  }

  #recordRejection(
    reason: WorkerRejectedReason,
    workerId: string | undefined,
    label: string | undefined,
  ): void {
    const key = `${reason}:${workerId ?? ""}`;
    const now = this.options.clock.now();
    const existing = this.#recentRejections.get(key);
    if (existing !== undefined && now - existing.windowStart < REJECTION_COALESCE_WINDOW_MS) {
      existing.count += 1;
      return;
    }
    const previousTotal = existing?.count;
    if (this.#recentRejections.size >= MAX_TRACKED_REJECTION_WINDOWS) {
      const oldestKey = this.#recentRejections.keys().next().value;
      if (oldestKey !== undefined) this.#recentRejections.delete(oldestKey);
    }
    this.#recentRejections.set(key, { count: 1, windowStart: now });
    this.#registry.rejected(
      reason,
      workerId,
      label,
      previousTotal === 1 ? undefined : previousTotal,
    );
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#tick !== undefined) {
      this.options.clock.cancel(this.#tick);
      this.#tick = undefined;
    }
    await this.#listener?.close();
    this.#listener = undefined;
    const links = [...this.#links.values()];
    this.#links.clear();
    await Promise.all(links.map((link) => link.close()));
  }

  #accept(uplink: AcceptedUplink): void {
    if (this.#stopped) {
      void uplink.connection.close();
      return;
    }
    // why: A worker that reconnects while the gateway still holds its previous link (a half-open
    // socket the OS has not reported dead) replaces it: the id is the worker's identity, and
    // the newest uplink is the one that can actually be driven. The old link is closed rather
    // than left to fight the new one over the same view.
    const previous = this.#links.get(uplink.workerId);
    if (previous !== undefined) {
      this.#logger.info("Worker reconnected while an uplink was still open; replacing it", {
        workerId: uplink.workerId,
      });
      void previous.close();
    }
    const link = new WorkerLink({
      clock: this.options.clock,
      eventBus: this.options.eventBus,
      // why: The same "is this still the current link" test as `onClosed` below, reused for D1: a
      // stale link's late close (the OS finally reporting a half-open socket dead, well after a
      // reconnect already replaced it) must not mark the registry's *current* entry
      // disconnected. One predicate, read from the same map, keeps both guards from drifting
      // apart.
      isCurrentLink: () => this.#links.get(uplink.workerId) === link,
      logger: this.#logger,
      onClosed: (workerId) => {
        // why: Only forget the link if it is still the current one: a replaced link's late close
        // must not evict its successor.
        if (this.#links.get(workerId) === link) this.#links.delete(workerId);
      },
      principal: this.options.principal,
      registry: this.#registry,
      uplink: {
        ...uplink,
        connection: createLink(uplink.connection, {
          clock: this.options.clock,
          end: "gateway",
          logger: this.#logger,
        }),
      },
      ...(this.options.connect === undefined ? {} : { connect: this.options.connect }),
    });
    this.#links.set(uplink.workerId, link);
    void link.start();
  }

  /**
   * why: One timer, rearmed after each run rather than a repeating interval, so a slow round of
   * refreshes can never overlap itself. Failures inside a refresh are the link's to log; this
   * loop only guarantees the next tick happens.
   */
  #scheduleTick(): void {
    if (this.#stopped) return;
    this.#tick = this.options.clock.setTimer(this.#refreshIntervalMs, () => {
      this.#tick = undefined;
      void this.#runTick().finally(() => this.#scheduleTick());
    });
  }

  async #runTick(): Promise<void> {
    await Promise.all(
      [...this.#links.values()].map((link) => link.refresh({ includeCatalog: true })),
    );
    await this.#registry.pruneExpired();
  }
}
