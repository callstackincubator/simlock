/**
 * The gateway's moving parts, wired together: the uplink listener, one `WorkerLink` per
 * connected worker, the worker registry those links write into, and the slow periodic tick that
 * backstops event-driven refreshes and sweeps expired views (ADR 0005 §6, §7).
 *
 * Everything here is lifecycle. What an operation *answers* lives in `GatewayDispatcher`, and
 * what a view *is* lives in `WorkerRegistry`; this class only makes sure both are fed.
 */
import type { EventBus } from "../bus/index.js";
import type {
  AcceptedUplink,
  Clock,
  Logger,
  TimerHandle,
  UplinkAuthOutcome,
  UplinkListener,
  UplinkListenerFactory,
} from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { DrainStore } from "./drain-store.js";
import { WorkerLink, type WorkerClientFactory } from "./worker-link.js";
import { WorkerRegistry } from "./worker-registry.js";

/**
 * How often the gateway refreshes every worker view and sweeps expired ones, absent an
 * override. ADR 0005 §7 asks for "a slow periodic tick as a backstop" -- slow because the
 * uplink's event stream is the real signal and this only catches what it missed (an event lost
 * to a refresh that failed, a worker whose `events.subscribe` was refused). Thirty seconds is
 * far below the shortest interesting lease TTL and far above anything that would make a fleet's
 * worth of `status.get` calls noticeable.
 */
export const DEFAULT_WORKER_REFRESH_INTERVAL_MS = 30_000;

export interface GatewayServiceOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly uplinks: UplinkListenerFactory;
  /**
   * Verifies a join token presented at upgrade (ADR 0005 §4/§25): `accept` only for a token the
   * gateway's own store holds with role `worker`; `forbidden` for a real token of another role;
   * `unauthenticated` for anything else. Injected rather than taking a token store, so this
   * module never learns what a token *is*.
   */
  readonly authenticate: (credential: string | undefined) => Promise<UplinkAuthOutcome>;
  /** `gateway.disconnectedRetentionMs` (§6). */
  readonly retentionMs: number;
  /** Where drained worker ids survive a restart (Decision 3). */
  readonly drainStore?: DrainStore;
  /** The principal the gateway announces to each worker at `hello`. */
  readonly principal: string;
  readonly logger?: Logger;
  readonly refreshIntervalMs?: number;
  /** Injected in tests to script a worker without a real daemon behind the uplink. */
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

  constructor(private readonly options: GatewayServiceOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_WORKER_REFRESH_INTERVAL_MS;
    this.#registry = new WorkerRegistry({
      clock: options.clock,
      eventBus: options.eventBus,
      retentionMs: options.retentionMs,
      ...(options.drainStore === undefined ? {} : { drainStore: options.drainStore }),
    });
  }

  /** The views every gateway handler reads. */
  get workers(): WorkerRegistry {
    return this.#registry;
  }

  async start(): Promise<void> {
    // Before the listener, not after: a worker that reconnects in the first millisecond must
    // find its drain state already restored, or it would be dispatched to once (#118) before
    // the flag landed.
    await this.#registry.load();
    this.#listener = await this.options.uplinks.listen({
      accept: (uplink) => this.#accept(uplink),
      authenticate: async (credential) => {
        const outcome = await this.options.authenticate(credential);
        // ADR 0005 §22's fleet audit trail includes the joins that failed: a revoked token
        // retrying at its backoff cap is invisible on the gateway otherwise, and "why is that
        // machine not in the fleet" is exactly the question an operator brings to
        // `simlock events`. The uplink carries no identity the gateway trusts at this point,
        // so the fact names no worker.
        if (outcome !== "accept") this.#registry.rejected(undefined, undefined);
        return outcome;
      },
    });
    this.#scheduleTick();
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
    // A worker that reconnects while the gateway still holds its previous link (a half-open
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
      eventBus: this.options.eventBus,
      logger: this.#logger,
      onClosed: (workerId) => {
        // Only forget the link if it is still the current one: a replaced link's late close
        // must not evict its successor.
        if (this.#links.get(workerId) === link) this.#links.delete(workerId);
      },
      principal: this.options.principal,
      registry: this.#registry,
      uplink,
      ...(this.options.connect === undefined ? {} : { connect: this.options.connect }),
    });
    this.#links.set(uplink.workerId, link);
    void link.start();
  }

  /**
   * One timer, rearmed after each run rather than a repeating interval, so a slow round of
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
    // Catalogs are re-read on the tick, not on every lease event: models and runtimes change
    // when someone installs an SDK, which is exactly the kind of slow change a backstop is for.
    await Promise.all(
      [...this.#links.values()].map((link) => link.refresh({ includeCatalog: true })),
    );
    this.#registry.pruneExpired();
  }
}
