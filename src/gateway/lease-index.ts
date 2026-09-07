/**
 * `FleetLeaseIndex`: the gateway's own record of which leases *it* issued (ADR 0005 §14, §16,
 * §27a, §30). Nothing here is persisted -- like every worker view, it is rebuilt from what a
 * worker reports (`rebuildFromWorker`) whenever the gateway can see it, which is what makes a
 * gateway restart lose nothing a worker restart would not also lose (Decision 5).
 *
 * A gateway lease id is minted once, at grant, as `${workerId}.${workerLeaseId}` (§16) and never
 * re-derived by splitting the string back apart -- every lookup in this class goes through the
 * map this index keeps, keyed by the id it minted or by the `(workerId, workerLeaseId)` pair a
 * relayed worker event carries. The "split on the first `.`" the ADR describes is what makes the
 * id *routable in principle* (a worker id is a UUID, so it can never itself contain the
 * separator); nothing in this codebase needs to actually perform that split, because this index
 * always has the structured pair already.
 */

/** One lease this gateway knows it issued. `requesterId`/`ownerId` are the *fleet-level*
 * identities -- `requesterId` with no `gw:<instance>:` prefix (what the client itself used),
 * `ownerId` the real principal ADR §27a rescued from a round trip through the worker. */
export interface FleetLeaseEntry {
  readonly gatewayLeaseId: string;
  readonly workerId: string;
  readonly workerLeaseId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly grantedAt: number;
}

/** The subset of a worker-reported lease record this index needs to recognize and rebuild its
 * own entries from (`WorkerView.leases`'s element shape, structurally). */
export interface WorkerReportedLease {
  readonly id: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly grantedAt: number;
}

/** A lease record projected for a fleet client: rewritten to the gateway's id and fleet-level
 * requester, with `worker` attached, when the index recognizes it; passed through unchanged
 * (plus `workerId`) when it does not -- a worker's own local lease, which this gateway never
 * issued and has no business renaming (test: "lease.list rewrites ids only for gateway-issued
 * leases; a worker's own local lease keeps its raw id"). */
export type ProjectedLease<Lease> = Lease extends {
  readonly id: string;
  readonly requesterId: string;
}
  ? Lease & {
      readonly workerId: string;
      readonly worker?: { readonly id: string; readonly label?: string };
    }
  : never;

export class FleetLeaseIndex {
  readonly #byGatewayId = new Map<string, FleetLeaseEntry>();
  readonly #byRequester = new Map<string, string>();
  readonly #byWorkerLease = new Map<string, string>();
  /** C3 (round 2 review): one strictly-increasing counter per worker, bumped on every
   * `rebuildFromWorker` call for that worker -- what lets reconciliation (below) tell "missing
   * from this snapshot" apart from "missing for a whole extra snapshot in a row" without
   * comparing clocks across two processes. */
  readonly #generation = new Map<string, number>();
  /** C3: the generation at which an entry attributed to a still-known worker was first found
   * absent from a `rebuildFromWorker` snapshot. Cleared the moment the entry is reported again
   * (the race this guards against is a one-snapshot fluke, not a real disappearance), and read
   * again by the *next* `rebuildFromWorker` call for that worker: still absent one full
   * generation later is what promotes "missing" to "gone" (see `rebuildFromWorker`'s own doc). */
  readonly #missingSince = new Map<string, number>();

  constructor(private readonly gatewayRequesterPrefix: string) {}

  /** `gw:<this gateway's instance id>:` -- what marks a requester id as this gateway's own
   * (§14/§27). Exposed so `FleetLeaseCoordinator` namespaces outgoing requester ids with the
   * exact same value this index recognizes them by. */
  get requesterPrefix(): string {
    return this.gatewayRequesterPrefix;
  }

  /** Every entry, for `lease.release-all` (§34's own-leases-only filter) and for a caller
   * reconciling worker ids that disappeared entirely (`forgetWorker`). */
  all(): readonly FleetLeaseEntry[] {
    return [...this.#byGatewayId.values()];
  }

  resolve(gatewayLeaseId: string): FleetLeaseEntry | undefined {
    return this.#byGatewayId.get(gatewayLeaseId);
  }

  findByWorkerLease(workerId: string, workerLeaseId: string): FleetLeaseEntry | undefined {
    const gatewayLeaseId = this.#byWorkerLease.get(workerKey(workerId, workerLeaseId));
    return gatewayLeaseId === undefined ? undefined : this.#byGatewayId.get(gatewayLeaseId);
  }

  ownerId(gatewayLeaseId: string): string | undefined {
    return this.resolve(gatewayLeaseId)?.ownerId;
  }

  /** The fleet-level requester a gateway lease is attributed to -- `roles.ts`'s
   * `AuthorizeContext.leaseRequesterId`, for `device.exec`'s admin-vs-agent gate. */
  leaseRequesterId(gatewayLeaseId: string): string | undefined {
    return this.resolve(gatewayLeaseId)?.requesterId;
  }

  /** ADR §14: the fleet-wide one-lease-per-requester check, keyed on `requesterId` (never
   * `ownerId` -- see the module doc on the distinction). `undefined` means "no lease", so a
   * caller gets the existing id to report (`RequesterAlreadyLeasedError`) in the same lookup
   * that answers the boolean question. */
  existingLeaseId(requesterId: string): string | undefined {
    return this.#byRequester.get(requesterId);
  }

  /** Records a lease this gateway just granted. Idempotent by `gatewayLeaseId`: granting twice
   * under the same id (it never happens outside a test) replaces rather than duplicates. */
  add(entry: FleetLeaseEntry): void {
    this.#byGatewayId.set(entry.gatewayLeaseId, entry);
    this.#byRequester.set(entry.requesterId, entry.gatewayLeaseId);
    this.#byWorkerLease.set(workerKey(entry.workerId, entry.workerLeaseId), entry.gatewayLeaseId);
  }

  /** Forgets one lease by its gateway id -- the gateway's own `lease.release` completing. */
  remove(gatewayLeaseId: string): FleetLeaseEntry | undefined {
    const entry = this.#byGatewayId.get(gatewayLeaseId);
    if (entry === undefined) return undefined;
    this.#forget(entry);
    return entry;
  }

  /**
   * Finds and forgets a lease by the `(workerId, workerLeaseId)` pair a relayed worker event
   * carries (`lease.expired`/`lease.released`, republished with `workerId` added). Atomic --
   * look up and remove in one call -- so `GatewayOwnerRoutedFacts` can resolve the fleet
   * `ownerId`/gateway lease id for its translated push *before* the entry is gone, with no
   * ordering dependency on which of two independent bus subscriptions runs first (finding 4:
   * "do not trust a relayed event's `ownerId`" only holds if the lookup and the forget are one
   * step, not two).
   */
  removeByWorkerLease(workerId: string, workerLeaseId: string): FleetLeaseEntry | undefined {
    const entry = this.findByWorkerLease(workerId, workerLeaseId);
    if (entry === undefined) return undefined;
    this.#forget(entry);
    return entry;
  }

  /**
   * Adds every gateway-issued lease a worker's current view reports that this index does not
   * already know (ADR §30's reconnect rebuild; also the ordinary per-refresh path, since
   * `WorkerView.leases` is always the worker's complete current set, not a delta). Recognizes
   * "gateway-issued" by `requesterId`'s prefix (§14) -- a worker's own local lease never carries
   * it and is silently skipped, exactly as it must be for `hasLease`'s admission check to mean
   * anything.
   *
   * Reconciling, not upsert-only (C3, round 2 review): an entry attributed to this worker that
   * this snapshot does not mention is removed too, so a worker that lost a gateway-issued lease
   * out of band -- restarted, or expired it while the uplink was down -- does not leave an
   * immortal entry behind that no relayed `lease.released`/`lease.expired` will ever arrive to
   * clear (removal used to have exactly one source of truth, that relayed fact; a worker that
   * forgot the lease before reconnecting can never produce one). `removeByWorkerLease` is still
   * what clears the ordinary case -- a relayed fact arriving for a lease this snapshot has
   * already dropped is simply a no-op there.
   *
   * The race the old upsert-only comment warned about is real and still handled: a lease this
   * gateway granted a moment ago could be missing from a `WorkerLink` refresh that started
   * *before* the grant landed on the worker, and removing on that stale a snapshot would evict a
   * lease that is very much still held. Protected by a watermark instead of never removing --
   * `#generation`/`#missingSince` (see their own doc comments) require an entry to be missing
   * from *two* consecutive snapshots for this worker before it is forgotten, so a single
   * unlucky race is always caught by the very next rebuild (the next periodic refresh, or the one
   * this class's own caller re-runs after every worker-view change) rather than evicting on the
   * first miss.
   */
  rebuildFromWorker(workerId: string, leases: readonly WorkerReportedLease[]): void {
    const generation = (this.#generation.get(workerId) ?? 0) + 1;
    this.#generation.set(workerId, generation);
    const reported = this.#addReported(workerId, leases);
    this.#reconcileMissing(workerId, generation, reported);
  }

  /** `rebuildFromWorker`'s addition half: adds every gateway-issued lease this snapshot reports
   * that the index does not already know, and returns the full set of gateway ids it saw (used
   * to know which of this worker's *existing* entries this snapshot did not mention). */
  #addReported(workerId: string, leases: readonly WorkerReportedLease[]): ReadonlySet<string> {
    const reported = new Set<string>();
    for (const lease of leases) {
      if (!lease.requesterId.startsWith(this.gatewayRequesterPrefix)) continue;
      const gatewayLeaseId = `${workerId}.${lease.id}`;
      reported.add(gatewayLeaseId);
      this.#missingSince.delete(gatewayLeaseId);
      if (this.#byGatewayId.has(gatewayLeaseId)) continue;
      this.add({
        gatewayLeaseId,
        grantedAt: lease.grantedAt,
        ownerId: lease.ownerId,
        requesterId: lease.requesterId.slice(this.gatewayRequesterPrefix.length),
        workerId,
        workerLeaseId: lease.id,
      });
    }
    return reported;
  }

  /** `rebuildFromWorker`'s removal half: forgets an existing entry for `workerId` that this
   * snapshot did not report, but only once it has failed to appear in *two* consecutive
   * snapshots (see `#missingSince`'s own doc comment for why one miss is not enough). */
  #reconcileMissing(workerId: string, generation: number, reported: ReadonlySet<string>): void {
    for (const entry of this.all()) {
      if (entry.workerId !== workerId || reported.has(entry.gatewayLeaseId)) continue;
      const firstMissedAt = this.#missingSince.get(entry.gatewayLeaseId);
      if (firstMissedAt === undefined) {
        this.#missingSince.set(entry.gatewayLeaseId, generation);
      } else if (firstMissedAt < generation) {
        this.#forget(entry);
      }
    }
  }

  /** Drops every entry attributed to a worker the gateway has forgotten entirely (its view was
   * removed -- `worker.remove`, or retention). A worker's view carrying no leases is not this:
   * that is the ordinary release/expiry path above. Also drops that worker's own `#generation`
   * counter (`#forget`, above, already clears each entry's own `#missingSince`) -- a worker id
   * that reconnects after this is a fresh start for reconciliation, not a continuation of one
   * that was, at the time, about a worker this index no longer has any record of at all. */
  forgetWorker(workerId: string): void {
    for (const entry of this.all()) {
      if (entry.workerId === workerId) this.#forget(entry);
    }
    this.#generation.delete(workerId);
  }

  /** Projects a worker-reported lease for a fleet client: rewritten when this index recognizes
   * it (by `(workerId, lease.id)`), passed through with only `workerId` added otherwise. */
  project<Lease extends { readonly id: string; readonly requesterId: string }>(
    lease: Lease,
    workerId: string,
    workerLabel: string | undefined,
  ): ProjectedLease<Lease> {
    const entry = this.findByWorkerLease(workerId, lease.id);
    if (entry === undefined) {
      return { ...lease, workerId } as ProjectedLease<Lease>;
    }
    return {
      ...lease,
      id: entry.gatewayLeaseId,
      requesterId: entry.requesterId,
      workerId,
      ...(workerLabel === undefined
        ? { worker: { id: workerId } }
        : { worker: { id: workerId, label: workerLabel } }),
    } as ProjectedLease<Lease>;
  }

  #forget(entry: FleetLeaseEntry): void {
    this.#byGatewayId.delete(entry.gatewayLeaseId);
    if (this.#byRequester.get(entry.requesterId) === entry.gatewayLeaseId) {
      this.#byRequester.delete(entry.requesterId);
    }
    this.#byWorkerLease.delete(workerKey(entry.workerId, entry.workerLeaseId));
    this.#missingSince.delete(entry.gatewayLeaseId);
  }
}

function workerKey(workerId: string, workerLeaseId: string): string {
  return `${workerId} ${workerLeaseId}`;
}
