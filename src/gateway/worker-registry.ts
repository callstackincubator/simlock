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
import {
  type grantedDeviceSchema,
  type ProtocolRange,
  workerViewSchema,
} from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { Clock, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { DrainStore } from "./drain-store.js";

export type WorkerView = z.infer<typeof workerViewSchema>;

/** The fields a refresh over the uplink replaces. Everything else on a view -- identity, drain
 * state, connection state -- is this registry's own bookkeeping, never a worker's to report. */
export type WorkerViewSnapshot = Pick<
  WorkerView,
  | "capacity"
  | "catalog"
  | "devices"
  | "downloads"
  | "health"
  | "host"
  | "installs"
  | "lease"
  | "leases"
  | "queueDepth"
  | "version"
  | "waiting"
>;

/** A worker's device in the shape a grant carries it: what `GET /v1/leases/{id}` builds a lease
 * payload from. Kept beside a view, never on it, because a view is what `status.get` and
 * `worker.list` show every agent, and `driverDeviceId` is only the lease holder's to see. */
export type WorkerGrantedDevice = z.infer<typeof grantedDeviceSchema>;

/** What one refresh over the uplink commits: the view's fields, and the same devices in the
 * grant shape. Both come from one refresh and land in one call, so a lease the view reports is
 * never visible before the device it names. */
export type WorkerRefresh = Partial<WorkerViewSnapshot> & {
  readonly grantedDevices?: readonly WorkerGrantedDevice[];
};

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
  /**
   * This gateway's own `lease.maxTtlMs` (ADR 0005 §15) -- what every view's reported
   * `lease.maxTtlMs` is compared against on `refresh()` to warn when a worker's own cap is
   * lower. Not optional: a real gateway always has this value (it is `config.lease.maxTtlMs`,
   * which always defaults to something), and there is no safe placeholder to compare against
   * in its absence.
   */
  readonly leaseMaxTtlMs: number;
  readonly logger?: Logger;
}

/**
 * A view without what a `status.get` read of a running worker fills in. A worker that answers
 * `starting` has had none of it checked, so what an earlier session saw is dropped rather than
 * shown as current: absent says "not known", where a stale or empty value would say "nothing
 * is leased".
 */
function withoutReadFields(view: WorkerView): WorkerView {
  const {
    capacity: _capacity,
    catalog: _catalog,
    catalogReadAt: _catalogReadAt,
    devices: _devices,
    installs: _installs,
    leases: _leases,
    queueDepth: _queueDepth,
    waiting: _waiting,
    ...rest
  } = view;
  return rest;
}

export class WorkerRegistry {
  readonly #workers = new Map<string, WorkerView>();
  /** Each worker's devices in the grant shape (see `WorkerGrantedDevice`). Set by `refresh`,
   * which writes nothing for a worker with no view, and deleted with the view by `#forget`. */
  readonly #grantedDevices = new Map<string, readonly WorkerGrantedDevice[]>();
  /** The last catalog a refresh carried, per worker. A `starting` refresh leaves `catalog` off
   * the view, but the gateway still knows what that worker listed when it last read it (ADR 0009
   * §4: a reconnecting worker stays known while its new catalog is on the way), so `routingViews`
   * hands routing this. Deleted with the view by `#forget`. */
  readonly #lastCatalog = new Map<string, NonNullable<WorkerView["catalog"]>>();
  /** The last leases a refresh carried, per worker. The same gap as `#lastCatalog`: a `starting`
   * refresh leaves `leases` off the view, which is "not known", not "none", so the retention
   * sweep and `worker.disconnected` read these instead (ADR 0005 §6). Deleted by `#forget`. */
  readonly #lastLeases = new Map<string, NonNullable<WorkerView["leases"]>>();
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
   * `views()` as routing reads them: a view with no `catalog`, a worker that answered `starting`,
   * carries the last catalog the gateway read from it, so the worker stays known (ADR 0009 §4).
   * Never shown to an operator: the view itself says "not read yet".
   */
  routingViews(): readonly WorkerView[] {
    return this.views().map((view) => {
      const catalog = this.#lastCatalog.get(view.id);
      return view.catalog === undefined && catalog !== undefined ? { ...view, catalog } : view;
    });
  }

  /**
   * Every worker's devices in the grant shape, each with the `workerId` it came from: what a
   * gateway's `GET /v1/leases/{id}` builds the lease payload from. Ordered by worker id, as
   * `views()` is. The caller matches a device by worker and id together, never by id alone.
   */
  grantedDevices(): readonly (WorkerGrantedDevice & { readonly workerId: string })[] {
    return this.views().flatMap((view) =>
      (this.#grantedDevices.get(view.id) ?? []).map((device) => ({
        ...device,
        workerId: view.id,
      })),
    );
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
    // The catalog the last session read stays, so a reconnecting worker is still known from it
    // (ADR 0009 §4); only when it was read is cleared, since nothing has been read this session.
    const { catalogReadAt: _stale, ...existing } = this.#workers.get(workerId) ?? {};
    const view: WorkerView = {
      ...existing,
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
      ...existing,
      connection: "incompatible",
      drained: this.#drained.has(workerId),
      id: workerId,
      lastSeenAt: this.options.clock.now(),
      protocol,
      ...(label === undefined ? {} : { label }),
      ...(version === undefined ? {} : { version }),
    };
    // ADR 0008 §8: host facts come from `status.get`, which an incompatible worker is never
    // asked. A view left over from an earlier, compatible session must not keep showing them,
    // nor the installs or waiting requests that status listed (ADR 0010 §7).
    const { host: _stale, installs: _staleInstalls, waiting: _staleWaiting, ...withoutHost } = view;
    this.#workers.set(workerId, withoutHost);
    this.#notifyViewsChanged();
    return withoutHost;
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
   *
   * P-2: `count`, when given, is how many identical (reason, claimed id) refusals the *previous*
   * coalescing window absorbed before it closed -- not a count of this event's own occurrence,
   * which is always exactly one. `GatewayService` reports it on the next matching refusal after
   * a window ages out, since every refusal here is unauthenticated by definition and the ring
   * buffer this lands in is bounded by count, not bytes (P3): without coalescing, a loop of
   * refused dials could otherwise emit one event per attempt and evict everything else in it.
   * Omitted (not zero or one) outside a flood, so the payload is unchanged from before this fix
   * in the overwhelmingly common case of an isolated refusal.
   */
  rejected(
    reason: "forbidden" | "unauthenticated",
    workerId: string | undefined,
    label: string | undefined,
    count?: number,
  ): void {
    this.options.eventBus.emit(
      "worker.rejected",
      {
        reason,
        ...(workerId === undefined ? {} : { workerId }),
        ...(label === undefined ? {} : { label }),
        ...(count === undefined ? {} : { count }),
      },
      "gateway",
    );
  }

  /**
   * Replaces what the worker reports. Partial on purpose: a refresh triggered by a lease event
   * re-reads status and devices but not the catalog (§7), and an absent key leaves the previous
   * value standing rather than blanking it -- except for a `starting` refresh, which says the
   * worker has checked nothing: it drops capacity, catalog, catalogReadAt, devices, installs,
   * leases, queueDepth and waiting from the view (absent means "not known"), keeping the last
   * catalog and leases aside for routing and retention. A refresh for a worker whose view is gone
   * (removed while a status call was in flight) is dropped rather than resurrecting it.
   */
  refresh(workerId: string, refresh: WorkerRefresh): void {
    const existing = this.#workers.get(workerId);
    if (existing === undefined) return;
    const { grantedDevices, ...snapshot } = refresh;
    const now = this.options.clock.now();
    const next: WorkerView = {
      ...(snapshot.health === "starting" ? withoutReadFields(existing) : existing),
      ...snapshot,
      lastSeenAt: now,
      // ADR 0009 §4: a refresh that carries a catalog is a read of it.
      ...(snapshot.catalog === undefined ? {} : { catalogReadAt: now }),
    };
    this.#workers.set(workerId, next);
    if (snapshot.catalog !== undefined) this.#lastCatalog.set(workerId, snapshot.catalog);
    if (snapshot.leases !== undefined) this.#lastLeases.set(workerId, snapshot.leases);
    if (grantedDevices !== undefined) this.#grantedDevices.set(workerId, grantedDevices);
    this.#warnOnLowerMaxTtl(existing, next);
    this.#notifyViewsChanged();
  }

  /**
   * ADR 0005 §15: the gateway's own `lease.maxTtlMs` decides a fleet lease's width at
   * admission, before any worker is chosen -- but what the gateway dispatches is an ordinary
   * `lease.request`, so a worker whose own cap is lower still refuses a request the gateway
   * already accepted. That mismatch becomes visible the moment this worker's `config.get`
   * answer lands in its view (`WorkerLink#rebuildView`), which is exactly where it is reported
   * here -- as a log line, not a bus event: an operator configuration warning is not a business
   * fact about the fleet (`docs/internal/agent-rules/events.md`), the same reasoning `core/config.ts`
   * already applies to a worker-only key left in a gateway's config.
   *
   * Warned on the transition into the mismatched state (or a change while inside it), never on
   * an unchanged refresh: `config.get` is re-read on every periodic backstop tick alongside the
   * catalog, and a worker whose reported cap has not moved must not repeat this warning every
   * `refreshIntervalMs`. Comparing the incoming cap against the *previous* view's own gives that
   * for free, with no extra state to track: a worker's first refresh after connecting has no
   * previous `lease.maxTtlMs` to match, so it warns the moment a low cap is first reported; a
   * later refresh reporting the identical cap finds `previous.lease?.maxTtlMs` already equal to
   * it and says nothing new.
   */
  #warnOnLowerMaxTtl(previous: WorkerView, next: WorkerView): void {
    const workerMaxTtlMs = next.lease?.maxTtlMs;
    // No cap reported (an incompatible worker, a failed config.get, or one older than this
    // field) is not a fact to warn about -- there is nothing to compare.
    if (workerMaxTtlMs === undefined || workerMaxTtlMs >= this.options.leaseMaxTtlMs) return;
    if (previous.lease?.maxTtlMs === workerMaxTtlMs) return;
    this.#logger.warn(
      "Worker's lease.maxTtlMs is below this gateway's own cap; requests the gateway accepts up to its own cap will be refused by this worker",
      {
        gatewayMaxTtlMs: this.options.leaseMaxTtlMs,
        workerId: next.id,
        workerMaxTtlMs,
        ...(next.label === undefined ? {} : { label: next.label }),
      },
    );
  }

  /**
   * ADR 0005 §6: the uplink is the reachability signal, and a closed one does not delete
   * anything. The view keeps its last-known state -- capacity, devices, and above all the
   * leases the worker still holds -- until retention elapses or an operator removes it.
   */
  disconnected(workerId: string): void {
    const existing = this.#workers.get(workerId);
    if (existing === undefined || existing.connection === "disconnected") return;
    // ADR 0010 §7: an install on a worker nobody can reach is not known to be in progress, so
    // the view stops listing it rather than showing it running for ever. The same goes for the
    // requests waiting in that worker's own queue.
    const { installs: _unknown, waiting: _unknownWaiting, ...withoutInstalls } = existing;
    this.#workers.set(workerId, {
      ...withoutInstalls,
      connection: "disconnected",
      lastSeenAt: this.options.clock.now(),
    });
    this.options.eventBus.emit(
      "worker.disconnected",
      {
        // A view that went away while `starting` has no leases listed; what the gateway last
        // read is what the worker still holds, which is what is stranded.
        leaseCount: (existing.leases ?? this.#lastLeases.get(workerId) ?? []).length,
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
   *
   * Hardening: a drain flag can outlive its view -- `pruneExpired`'s retention sweep
   * deliberately does not clear it (C1: only an explicit `undrain` should end a drain), so a
   * worker that drops off and ages out of retention while still drained leaves `#drained`
   * holding an id with nothing left to view. Neither `setDrained` nor `undrain` can reach it at
   * that point (`#requireView` throws `UNKNOWN_WORKER`), which is exactly M1's "unbounded file"
   * relocated rather than closed: nothing could ever clear that flag again, short of editing
   * `workers.json` by hand. `remove` on that same id is the one command already documented as
   * "no view to forget is fine" (`removed: false`) -- letting it also clear a leftover flag,
   * still answering `removed: false`, is what actually closes the file rather than moving the
   * leak.
   */
  async remove(workerId: string): Promise<boolean> {
    const existing = this.#workers.get(workerId);
    if (existing === undefined) {
      if (this.#drained.delete(workerId)) {
        await this.options.drainStore?.save([...this.#drained]);
      }
      // Unlike drain, an id with no view is not an error: "forget this worker" is already true
      // of one the gateway has never heard of or has already retired, so it is an outcome to
      // report (`removed: false`) rather than a failure to raise.
      return false;
    }
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
        // A view with no `leases` field is "not read" (a worker never read, or one that went
        // away while starting): the leases last read stand, and none when none ever were.
        !(view.leases ?? this.#lastLeases.get(view.id) ?? []).some(
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
    this.#grantedDevices.delete(view.id);
    this.#lastCatalog.delete(view.id);
    this.#lastLeases.delete(view.id);
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
