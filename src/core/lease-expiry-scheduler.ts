import type { Clock, TimerHandle } from "../ports/index.js";
import type { LeaseRecord } from "./domain.js";

export type LeaseExpiryHandler = (leaseId: string) => void | Promise<void>;

/** Owns TTL timers; expiry is delivered directly to the lease lifecycle. */
export class LeaseExpiryScheduler {
  readonly #timers = new Map<string, TimerHandle>();
  #disposed = false;

  constructor(
    private readonly clock: Clock,
    private readonly onExpiry: LeaseExpiryHandler,
  ) {}

  arm(lease: LeaseRecord): void {
    if (this.#disposed) return;
    this.cancel(lease.id);
    if (lease.ttlDeadline <= this.clock.now()) {
      void this.#expire(lease.id);
      return;
    }
    this.#timers.set(
      lease.id,
      this.clock.setTimer(lease.ttlDeadline - this.clock.now(), () => {
        this.#timers.delete(lease.id);
        void this.#expire(lease.id);
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
        await this.#expire(lease.id);
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

  async #expire(leaseId: string): Promise<void> {
    if (!this.#disposed) await this.onExpiry(leaseId);
  }
}

function compareLeaseDeadlines(left: LeaseRecord, right: LeaseRecord): number {
  return left.ttlDeadline - right.ttlDeadline || left.id.localeCompare(right.id);
}
