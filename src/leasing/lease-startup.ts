import type { EventBus } from "../bus/index.js";
import type {
  LeaseRequestFailure,
  LeaseRequestRecord,
  SerializedDecision,
  StartupRead,
} from "../core/index.js";

export interface LeaseStartupRegistry {
  failOpenLeaseRequests(failure: LeaseRequestFailure): Promise<readonly LeaseRequestRecord[]>;
}

/** Restores every persisted lease's TTL timer. */
export interface LeaseTimerRestorer {
  restoreExpiryTimers(): Promise<void>;
}

/** Ends every lease whose device the startup read says is not running. */
export interface LeaseStartupReconciler {
  run(read: StartupRead): Promise<void>;
}

export interface LeaseStartupOptions {
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly reconciler: LeaseStartupReconciler;
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
 * The lease half of startup, run around core's startup read and before admission opens (the
 * dispatcher parks every request until startup resolves).
 *
 * First, no wait from the previous process survived it, so every request it left open is settled
 * now rather than left open with nothing to drive it (`settleRequests`). Then, once the daemon has
 * read each platform, every lease is checked against that read (ADR 0019): one whose device is not
 * running is ended, and the leases that remain have their timers restored from their own persisted
 * deadlines (`reconcile`). A restart does not prove a holder is dead, so a lease whose device is
 * running is kept. One whose deadline already passed while no daemon was running expires here,
 * through the ordinary expiry path `restore` drives.
 */
export class LeaseStartup {
  constructor(private readonly options: LeaseStartupOptions) {}

  async settleRequests(): Promise<void> {
    await this.#settleOpenLeaseRequests();
  }

  async reconcile(read: StartupRead): Promise<void> {
    await this.options.reconciler.run(read);
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
