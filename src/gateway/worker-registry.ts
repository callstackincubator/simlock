/**
 * The gateway's picture of its fleet: one `WorkerView` per worker it has seen, and the facts it
 * emits as those views change (ADR 0005 §6, §8, §9, §22).
 *
 * Views are rebuilt over the uplink (§30: a gateway restart re-derives everything from the
 * workers that reconnect). Exactly one thing on them is persisted -- the drained set, which no
 * worker reports and which must survive both a worker reconnect and a gateway restart (Decision
 * 3, see `./drain-store.ts`). This class owns *what a view is and when it changes*; `WorkerLink`
 * owns the uplink that supplies the facts, and `GatewayDispatcher` owns answering operations
 * from them.
 */
import type { z } from "zod";

import type { EventBus } from "../bus/index.js";
import { workerViewSchema, type ProtocolRange } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { Clock, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { DrainStore } from "./drain-store.js";

export type WorkerView = z.infer<typeof workerViewSchema>;

/** The fields a refresh over the uplink replaces. Everything else on a view -- identity, drain
 * state, connection state -- is this registry's own bookkeeping, never a worker's to report. */
export type WorkerViewSnapshot = Pick<
  WorkerView,
  "capacity" | "catalog" | "devices" | "downloads" | "health" | "leases" | "queueDepth" | "version"
>;

export interface WorkerRegistryOptions {
  readonly clock: Clock;
  readonly eventBus: EventBus;
  /** `gateway.disconnectedRetentionMs` (ADR 0005 §6). */
  readonly retentionMs: number;
  /**
   * Where the drained set is kept across restarts (ADR 0005, Decision 3). Optional so a test
   * that does not care about persistence need not fabricate one; a gateway always has one.
   */
  readonly drainStore?: DrainStore;
  /**
   * `gw:<this gateway's instance id>:` (ADR 0005 §14/§27) -- what marks a lease as *this*
   * gateway's own, rather than another gateway's or a worker's local one. Scopes the retention
   * hold (§6) to leases this gateway issued: a worker's own local lease is none of this
   * gateway's business to keep a view alive for, and holding one anyway would mean a machine
   * with only local traffic never leaves an operator's `simlock worker remove` after it
   * disconnects (M2). Optional so a test exercising nothing lease-shaped need not supply one;
   * a real gateway always does.
   */
  readonly gatewayRequesterPrefix?: string;
  readonly logger?: Logger;
}

export class WorkerRegistry {
  readonly #workers = new Map<string, WorkerView>();
  /**
   * Drained worker ids, including ids with no view yet. Kept beside the views rather than only
   * on them because drain outlives a view: an operator drains a machine, the machine is turned
   * off (its view eventually retired), and when it comes back it must still be drained. This
   * set is what `load()` restores and what `setDrained` writes back.
   */
  readonly #drained = new Set<string>();
  /** `./fleet-ports.ts`'s `FleetViews#onViewsChanged` -- see that method's own doc comment. */
  readonly #viewsChangedListeners = new Set<() => void>();
  readonly #logger: Logger;

  constructor(private readonly options: WorkerRegistryOptions) {
    this.#logger = options.logger ?? new NoopLogger();
  }

  /** Restores the persisted drain set. Called once, before the uplink listener starts, so a
   * worker that reconnects in the first second is already drained when its view is built. */
  async load(): Promise<void> {
    for (const workerId of (await this.options.drainStore?.load()) ?? []) {
      this.#drained.add(workerId);
    }
  }

  /** Every view, ordered by id so two calls in a row -- and two gateways -- agree. */
  views(): readonly WorkerView[] {
    return [...this.#workers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  view(workerId: string): WorkerView | undefined {
    return this.#workers.get(workerId);
  }

  /**
   * `./fleet-ports.ts`'s `FleetViews#onViewsChanged` -- #118's seam for running dispatch
   * whenever the fleet's queue or any worker view changes (ADR 0005 §11), without reaching into
   * this registry's internals or polling it. Called once per mutation this registry actually
   * commits (`connected`, `incompatible`, `refresh`, `disconnected`, `setDrained`, `remove`,
   * `pruneExpired`) -- never for a call that finds nothing to change (an unknown worker, a
   * refresh dropped for a view already gone, draining an already-drained worker) -- and always
   * *after* the commit and after the corresponding event, if any, is emitted (`events.md`'s
   * post-commit rule). Returns the unsubscribe function.
   *
   * A listener that throws is logged at debug and does not stop the mutation that triggered it
   * or any other listener: this registry's own correctness must never depend on what a
   * subscriber does with the notification.
   */
  onViewsChanged(listener: () => void): () => void {
    this.#viewsChangedListeners.add(listener);
    return () => {
      this.#viewsChangedListeners.delete(listener);
    };
  }

  #notifyViewsChanged(): void {
    for (const listener of this.#viewsChangedListeners) {
      try {
        listener();
      } catch (error: unknown) {
        this.#logger.debug("A worker-views-changed listener threw", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * A worker's uplink is open. A view that already exists keeps its drain state -- draining is
   * an operator's decision about a *machine*, and a worker that reconnects (a restart, a
   * flapping network) has not undone it. Everything the worker itself reports is left for the
   * first refresh; until then the view says `connected` and carries whatever the last session
   * saw, which is more useful to a console than an empty one.
   */
  connected(workerId: string, label: string | undefined, version: string | undefined): WorkerView {
    const existing = this.#workers.get(workerId);
    const view: WorkerView = {
      ...(existing ?? { catalog: [], devices: [], leases: [] }),
      connection: "connected",
      // Read from the persisted set, not from the previous view: a worker connecting for the
      // first time after a gateway restart has no previous view, and must still be drained.
      drained: this.#drained.has(workerId),
      id: workerId,
      lastSeenAt: this.options.clock.now(),
      ...(label === undefined ? {} : { label }),
      ...(version === undefined ? {} : { version }),
    };
    // A reconnect after an `incompatible` session must not keep the old ranges around.
    const { protocol: _dropped, ...withoutProtocol } = view;
    this.#workers.set(workerId, withoutProtocol);
    this.options.eventBus.emit(
      "worker.connected",
      {
        workerId,
        ...(label === undefined ? {} : { label }),
        ...(version === undefined ? {} : { version }),
      },
      "gateway",
    );
    this.#notifyViewsChanged();
    return withoutProtocol;
  }

  /**
   * ADR 0005 §31: the uplink is open but `hello` found no overlapping protocol version. The
   * view records both ranges and nothing else -- the gateway asked the worker nothing, because
   * it cannot.
   *
   * No event either way, deliberately. Not `worker.connected`, because nothing usable
   * connected; and not `worker.rejected`, because that one is about the door (§22) and this
   * uplink authenticated fine. What an operator needs here is the *standing* fact "this
   * machine is too old to drive", and that is the view -- which `simlock worker list` shows
   * until the machine is upgraded, rather than a line that scrolls out of the ring buffer
   * while the worker keeps redialling.
   */
  incompatible(
    workerId: string,
    label: string | undefined,
    protocol: { readonly gateway: ProtocolRange; readonly worker: ProtocolRange },
    version: string | undefined,
  ): WorkerView {
    const existing = this.#workers.get(workerId);
    const view: WorkerView = {
      ...(existing ?? { catalog: [], devices: [], leases: [] }),
      connection: "incompatible",
      drained: this.#drained.has(workerId),
      id: workerId,
      lastSeenAt: this.options.clock.now(),
      protocol,
      ...(label === undefined ? {} : { label }),
      ...(version === undefined ? {} : { version }),
    };
    this.#workers.set(workerId, view);
    this.#notifyViewsChanged();
    return view;
  }

  /**
   * An uplink the gateway turned away at the upgrade (ADR 0005 §4/§22). The reason is the
   * outcome the token check produced, kept apart here for the same reason it is kept apart on
   * the wire: `unauthenticated` (`401`) is "no token, or one I do not know" and points at the
   * join token, while `forbidden` (`403`) is "a real credential without this authority" and
   * points at its role -- two different things for an operator to go and fix.
   *
   * There is no view to build: the peer never became a worker, so this is a fact and nothing
   * else, and `workerId` is only ever what the connection claimed in its header.
   */
  rejected(
    reason: "forbidden" | "unauthenticated",
    workerId: string | undefined,
    label: string | undefined,
  ): void {
    this.options.eventBus.emit(
      "worker.rejected",
      {
        reason,
        ...(workerId === undefined ? {} : { workerId }),
        ...(label === undefined ? {} : { label }),
      },
      "gateway",
    );
  }

  /**
   * Replaces what the worker reports. Partial on purpose: a refresh triggered by a lease event
   * re-reads status and devices but not the catalog (§7), and an absent key must leave the
   * previous value standing rather than blank it. A refresh for a worker whose view is gone
   * (removed while a status call was in flight) is dropped rather than resurrecting it.
   */
  refresh(workerId: string, snapshot: Partial<WorkerViewSnapshot>): void {
    const existing = this.#workers.get(workerId);
    if (existing === undefined) return;
    this.#workers.set(workerId, {
      ...existing,
      ...snapshot,
      lastSeenAt: this.options.clock.now(),
    });
    this.#notifyViewsChanged();
  }

  /**
   * ADR 0005 §6: the uplink is the reachability signal, and a closed one does not delete
   * anything. The view keeps its last-known state -- capacity, devices, and above all the
   * leases the worker still holds -- until retention elapses or an operator removes it.
   */
  disconnected(workerId: string): void {
    const existing = this.#workers.get(workerId);
    if (existing === undefined || existing.connection === "disconnected") return;
    this.#workers.set(workerId, {
      ...existing,
      connection: "disconnected",
      lastSeenAt: this.options.clock.now(),
    });
    this.options.eventBus.emit(
      "worker.disconnected",
      {
        leaseCount: existing.leases.length,
        workerId,
        ...(existing.label === undefined ? {} : { label: existing.label }),
      },
      "gateway",
    );
    this.#notifyViewsChanged();
  }

  /**
   * ADR 0005 §9. Idempotent by design: draining an already-drained worker succeeds and emits
   * nothing, because nothing changed and an event is a fact about a change. An operator
   * re-running a command should not have to care, and neither should a script.
   *
   * Persisted before it returns (Decision 3): the point of drain is that a machine stays out of
   * rotation across the reconnect an operator is about to cause by working on it.
   */
  async setDrained(workerId: string, drained: boolean): Promise<WorkerView> {
    const existing = this.#requireView(workerId);
    if (existing.drained === drained) return existing;
    const view: WorkerView = { ...existing, drained };
    this.#workers.set(workerId, view);
    if (drained) this.#drained.add(workerId);
    else this.#drained.delete(workerId);
    await this.options.drainStore?.save([...this.#drained]);
    this.options.eventBus.emit(
      drained ? "worker.drain-started" : "worker.drain-ended",
      { workerId, ...(existing.label === undefined ? {} : { label: existing.label }) },
      "gateway",
    );
    this.#notifyViewsChanged();
    return view;
  }

  /**
   * ADR 0005 §8: forgets a disconnected worker's view. A connected one is refused --
   * `worker.remove` on a live worker would forget a machine that announces itself again on its
   * very next frame, which is a confusing no-op rather than an operator action. An
   * `incompatible` worker counts as connected for this rule: its uplink is open, and removing
   * it would do just as little.
   */
  async remove(workerId: string): Promise<boolean> {
    const existing = this.#workers.get(workerId);
    // Unlike drain, an id with no view is not an error: "forget this worker" is already true of
    // one the gateway has never heard of or has already retired, so it is an outcome to report
    // (`removed: false`) rather than a failure to raise.
    if (existing === undefined) return false;
    if (existing.connection !== "disconnected") {
      throw new DispatchError(
        "WORKER_CONNECTED",
        `Worker ${workerId} is still connected; drain it and wait for it to disconnect, or stop it first`,
        { workerId },
      );
    }
    await this.#forget(existing, "operator", { clearDrain: true });
    return true;
  }

  /**
   * ADR 0005 §6's retention sweep, run from the gateway's periodic tick. Two conditions, both
   * required:
   *
   * 1. every *gateway-issued* lease the view still shows has passed its deadline -- a lease
   *    this gateway granted with time left on it is a device still held on a machine that went
   *    away, which is exactly what an operator must be able to see, however long ago it went.
   *    Once the last deadline passes, the worker's own TTL has reclaimed everything (or will
   *    the moment it comes back), so the view is only history. A worker's own *local* lease is
   *    none of this gateway's business (§14): scoping by the `gw:<instance id>:` prefix it
   *    stamps on everything it forwards is what keeps a machine serving only local agents from
   *    being held here forever (M2) -- without it, `remove` on such a worker would still work
   *    (it only checks `connection`), but this sweep would never volunteer to do the same;
   * 2. and the view has been disconnected for longer than
   *    `gateway.disconnectedRetentionMs`.
   *
   * Deadlines, not just "any lease": a worker that dropped off months ago with leases recorded
   * would otherwise be kept forever by leases that expired minutes after it left.
   *
   * H3, `safety.md`'s fails-closed instinct: a registry built with no `gatewayRequesterPrefix`
   * cannot tell a gateway-issued lease from a worker-local one, so it must not guess "none of
   * these are mine" -- that would prune a view out from under live gateway leases just because
   * the option was left off. Treat a missing prefix as "every unexpired lease counts", i.e.
   * hold the view, rather than as "no lease counts".
   */
  async pruneExpired(): Promise<void> {
    const now = this.options.clock.now();
    const cutoff = now - this.options.retentionMs;
    const prefix = this.options.gatewayRequesterPrefix;
    const expired = this.views().filter(
      (view) =>
        view.connection === "disconnected" &&
        view.lastSeenAt <= cutoff &&
        !view.leases.some(
          (lease) =>
            lease.ttlDeadline > now &&
            (prefix === undefined || lease.requesterId.startsWith(prefix)),
        ),
    );
    for (const view of expired) await this.#forget(view, "retention", { clearDrain: false });
  }

  /**
   * M1: on an operator `remove`, also clears this worker's drain flag and re-saves the store, if
   * it had one. Without this, a removed worker's `true` survives in `workers.json` forever -- an
   * unbounded file that silently re-drains the machine if its id is ever seen again, with
   * `undrain` unable to clear it in the meantime (`UNKNOWN_WORKER`, since there is no view to
   * undrain). "Forgotten" has to mean forgotten, not "forgotten except the one flag that matters
   * most."
   *
   * C1: the retention sweep must NOT clear the drain flag. Retention forgetting the *view* is
   * not an operator action -- ADR 0005 §9 says only `undrain` ends a drain, and §8a keeps
   * `#drained` a separate record from the observed view precisely so a drain outlives it. A
   * drained worker that goes quiet past `disconnectedRetentionMs` must still rejoin drained.
   */
  async #forget(
    view: WorkerView,
    reason: "operator" | "retention",
    { clearDrain }: { clearDrain: boolean },
  ): Promise<void> {
    this.#workers.delete(view.id);
    if (clearDrain && this.#drained.delete(view.id)) {
      await this.options.drainStore?.save([...this.#drained]);
    }
    this.options.eventBus.emit(
      "worker.removed",
      { reason, workerId: view.id, ...(view.label === undefined ? {} : { label: view.label }) },
      "gateway",
    );
    this.#notifyViewsChanged();
  }

  #requireView(workerId: string): WorkerView {
    const view = this.#workers.get(workerId);
    if (view === undefined) {
      throw new DispatchError("UNKNOWN_WORKER", `Unknown worker: ${workerId}`, { workerId });
    }
    return view;
  }
}
