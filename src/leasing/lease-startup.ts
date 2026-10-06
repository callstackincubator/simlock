import type { EventBus } from "../bus/index.js";
import type { LeaseRequestFailure, LeaseRequestRecord, SerializedDecision } from "../core/index.js";

export interface LeaseStartupRegistry {
  failOpenLeaseRequests(failure: LeaseRequestFailure): Promise<readonly LeaseRequestRecord[]>;
}

/** Restores every persisted lease's TTL timer. */
export interface LeaseTimerRestorer {
  restoreExpiryTimers(): Promise<void>;
}

export interface LeaseStartupOptions {
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly registry: LeaseStartupRegistry;
  readonly timers: LeaseTimerRestorer;
}

/**
 * What a request still open at a restart is settled with. `INTERNAL` rather than a transport
 * code: the request is finished, and a client that retried a transport error under the same key
 * would only ever get this answer back.
 */
const DAEMON_RESTARTED: LeaseRequestFailure = {
  code: "INTERNAL",
  message: "The daemon restarted before this lease request settled; send it again with a new key",
};

/**
 * The lease half of startup, run before core's device steps and before admission opens (the
 * dispatcher parks every request until startup resolves).
 *
 * First, no wait from the previous process survived it, so every request it left open is settled
 * now rather than left open with nothing to drive it. Then, under ADR 0004, every lease's timer
 * is restored from its own persisted deadline and nothing is swept: a restart does not prove a
 * holder is dead, so no lease is released on the strength of one. A lease whose deadline already
 * passed while no daemon was running expires here, through the ordinary expiry path `restore`
 * drives.
 */
export class LeaseStartup {
  constructor(private readonly options: LeaseStartupOptions) {}

  async run(): Promise<void> {
    await this.#settleOpenLeaseRequests();
    await this.options.timers.restoreExpiryTimers();
  }

  async #settleOpenLeaseRequests(): Promise<void> {
    const settled = await this.options.decisions.run(() =>
      this.options.registry.failOpenLeaseRequests(DAEMON_RESTARTED),
    );
    for (const record of settled) {
      this.options.eventBus.emit(
        "lease.rejected",
        {
          requestId: record.id,
          requester: record.requesterId,
          requestSpec: record.request,
          reason: "daemon-restarted",
        },
        "lease-startup",
      );
    }
  }
}
