import type { EventBus } from "../bus/index.js";

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
 */
export class LeaseNoticeBuffer {
  readonly #buffered = new Map<string, LeaseNotice[]>();
  readonly #listeners = new Map<string, Set<(notice: LeaseNotice) => void>>();
  readonly #unsubscribers: Array<() => void>;

  constructor(eventBus: EventBus) {
    this.#unsubscribers = [
      eventBus.subscribe("device.crash-detected", (envelope) => {
        this.#push(envelope.payload.leaseId, { event: "device_unhealthy" });
      }),
      eventBus.subscribe("device.recovered", (envelope) => {
        this.#push(envelope.payload.leaseId, {
          attempts: envelope.payload.attempts,
          event: "device_recovered",
        });
      }),
      eventBus.subscribe("lease.released", (envelope) => {
        this.#push(envelope.payload.leaseId, {
          event: "lease_lost",
          reason: envelope.payload.reason,
        });
        this.#buffered.delete(envelope.payload.leaseId);
      }),
      eventBus.subscribe("lease.expired", (envelope) => {
        this.#push(envelope.payload.leaseId, { event: "lease_lost", reason: "expired" });
        this.#buffered.delete(envelope.payload.leaseId);
      }),
    ];
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
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
  }

  #push(leaseId: string, notice: LeaseNotice): void {
    const buffered = this.#buffered.get(leaseId) ?? [];
    buffered.push(notice);
    this.#buffered.set(leaseId, buffered);
    for (const listener of this.#listeners.get(leaseId) ?? []) listener(notice);
  }
}
