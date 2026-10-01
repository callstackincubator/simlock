import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../ports/index.js";
import type { LeaseRecord } from "./domain.js";
import { stableError } from "./stable-error.js";

export type LeaseExpiryHandler = (
  leaseId: string,
  expectedDeadline: number,
) => void | Promise<void>;

/** Owns TTL timers; expiry is delivered directly to the lease lifecycle. */
export class LeaseExpiryScheduler {
  readonly #timers = new Map<string, TimerHandle>();
  #disposed = false;
  readonly #logger: Logger;

  constructor(
    private readonly clock: Clock,
    private readonly onExpiry: LeaseExpiryHandler,
    logger?: Logger,
  ) {
    this.#logger = logger?.child("lease-expiry-scheduler") ?? new NoopLogger();
  }

  arm(lease: LeaseRecord): void {
    if (this.#disposed) return;
    this.cancel(lease.id);
    if (lease.ttlDeadline <= this.clock.now()) {
      void this.#deliverExpiry(lease.id, lease.ttlDeadline);
      return;
    }
    this.#timers.set(
      lease.id,
      this.clock.setTimer(lease.ttlDeadline - this.clock.now(), () => {
        this.#timers.delete(lease.id);
        void this.#deliverExpiry(lease.id, lease.ttlDeadline);
      }),
    );
  }

  replace(lease: LeaseRecord): void {
    this.arm(lease);
  }

  cancel(leaseId: string): void {
    const timer = this.#timers.get(leaseId);
    if (timer === undefined) return;
    this.clock.cancel(timer);
    this.#timers.delete(leaseId);
  }

  /** Restores timers in deadline/id order, processing expired leases immediately. */
  async restore(leases: readonly LeaseRecord[]): Promise<void> {
    if (this.#disposed) return;
    for (const lease of [...leases].sort(compareLeaseDeadlines)) {
      this.cancel(lease.id);
      if (lease.ttlDeadline <= this.clock.now()) {
        await this.#expire(lease.id, lease.ttlDeadline);
      } else {
        this.arm(lease);
      }
    }
  }

  dispose(): void {
    for (const timer of this.#timers.values()) this.clock.cancel(timer);
    this.#timers.clear();
    this.#disposed = true;
  }

  #deliverExpiry(leaseId: string, expectedDeadline: number): void {
    void this.#expire(leaseId, expectedDeadline).catch((error: unknown) => {
      this.#logger.error("lease expiry failed", {
        leaseId,
        step: "expire",
        error: stableError(error),
      });
    });
  }

  async #expire(leaseId: string, expectedDeadline: number): Promise<void> {
    if (!this.#disposed) await this.onExpiry(leaseId, expectedDeadline);
  }
}

function compareLeaseDeadlines(left: LeaseRecord, right: LeaseRecord): number {
  return left.ttlDeadline - right.ttlDeadline || left.id.localeCompare(right.id);
}
