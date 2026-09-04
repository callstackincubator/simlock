import type { OwnerRoutedFacts } from "../daemon/owner-routed-facts.js";

export type LeaseNotice =
  | { readonly event: "device_unhealthy" }
  | { readonly event: "device_recovered"; readonly attempts: number }
  | { readonly event: "lease_lost"; readonly reason: string };

/**
 * Buffers per-lease health facts between renews and fans them out to any live SSE listener.
 * A notice that arrives while a stream is connected is buffered *and* pushed live, so a renew
 * and a stream watching the same lease may each deliver it (at-least-once across channels).
 * The one asymmetry: `subscribe`'s initial flush drains the buffer, so notices from before
 * the stream connected reach only the stream -- they were delivered, just not twice.
 * `lease.released` / `lease.expired` clear the buffer for that lease afterwards: once the
 * lease is gone, `LeaseCommands.renew` already answers `UNKNOWN_LEASE` before anything here
 * would be read again, so there is nothing left worth retaining.
 *
 * ADR 0003 §8: consumes `OwnerRoutedFacts` -- the same lease-scoped, owner-attributed fact
 * stream the socket path's push routing (`DaemonServer#notifyLeaseLost` and friends) is fed
 * from -- rather than subscribing to the raw event bus itself. This class only ever needed the
 * per-lease facts (it doesn't filter by owner; a lease's SSE stream is already gated to its
 * owner at the route level), so it drops the events wholesale-, keying only by `leaseId`.
 */
export class LeaseNoticeBuffer {
  readonly #buffered = new Map<string, LeaseNotice[]>();
  readonly #listeners = new Map<string, Set<(notice: LeaseNotice) => void>>();
  readonly #unsubscribe: () => void;

  constructor(facts: OwnerRoutedFacts) {
    this.#unsubscribe = facts.subscribe((fact) => {
      switch (fact.type) {
        case "device-unhealthy":
          this.#push(fact.leaseId, { event: "device_unhealthy" });
          return;
        case "device-recovered":
          this.#push(fact.leaseId, { attempts: fact.attempts, event: "device_recovered" });
          return;
        case "lease-lost":
          this.#push(fact.leaseId, { event: "lease_lost", reason: fact.reason });
          this.#buffered.delete(fact.leaseId);
          return;
      }
    });
  }

  /** Drains and clears the buffered notices for `leaseId`, for the renew response's `notices` field. */
  drain(leaseId: string): LeaseNotice[] {
    const notices = this.#buffered.get(leaseId) ?? [];
    this.#buffered.delete(leaseId);
    return notices;
  }

  /**
   * Live feed for a lease's SSE stream: flushes whatever is already buffered first, so a
   * client that connects after a notice fired doesn't miss it, then pushes future notices.
   */
  subscribe(leaseId: string, listener: (notice: LeaseNotice) => void): () => void {
    for (const notice of this.drain(leaseId)) listener(notice);
    const listeners = this.#listeners.get(leaseId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(leaseId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(leaseId);
    };
  }

  dispose(): void {
    this.#unsubscribe();
  }

  #push(leaseId: string, notice: LeaseNotice): void {
    const buffered = this.#buffered.get(leaseId) ?? [];
    buffered.push(notice);
    this.#buffered.set(leaseId, buffered);
    for (const listener of this.#listeners.get(leaseId) ?? []) listener(notice);
  }
}
