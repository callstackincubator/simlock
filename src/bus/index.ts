import { type Clock, CryptoIdGenerator, type IdGenerator } from "../ports/index.js";
import { byTimeThenSeq } from "./order.js";

export interface CapacityFiguresPayload {
  readonly running: number;
  readonly maxRunning: number;
  readonly reserved: number;
  readonly warm: number;
}

export interface EventMap {
  "lease.requested": {
    /** The stored request's id, so an observer can correlate this event with its record. */
    readonly requestId: string;
    /** The request as it arrived (ADR 0015 §9): `class` when it named one, and `model` only when
     * it did. A request naming neither carries neither; the class it means is `phone`. */
    readonly requestSpec: unknown;
    readonly requester: string;
    readonly waitPolicy: string;
  };
  "lease.queued": { readonly requestId: string; readonly queuePosition: number };
  /** ADR 0004's Consequences: `mode` left this payload, a deliberate one-off exception to
   * events rule 6 (additive changes only) taken while the package is 0.x -- there is one kind
   * of lease now, so there is nothing to report. `EVENTS.md` records the exception. */
  "lease.granted": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly requester: string;
    /** The stored request this lease served: the id its `lease.requested` carried. */
    readonly requestId: string;
    /** How the device came to be ready: handed over `warm`, `booted` from shut down, or
     * `provisioned` for this request. */
    readonly source: "warm" | "booted" | "provisioned";
  };
  "lease.renewed": { readonly leaseId: string; readonly newDeadline: number };
  "lease.released": {
    readonly leaseId: string;
    readonly deviceId: string;
    /**
     * Who ended this lease, and whether its holder asked: `explicit` is a `lease.release` the
     * holder itself sent (including the one a `simlock lease` sends on its way out), `killed`
     * an operator taking it away (`release --all`, `nuke`), `device-lost` crash recovery
     * giving up, or a daemon start finding the device not running. Expiry is not in this union at all -- it has its own event.
     *
     * ADR 0004's Consequences: `closed` and `orphaned` are gone from it, the same deliberate
     * 0.x exception to events rule 6. Closing a connection is not a release any more (§3), and
     * there is no startup sweep left to orphan anything.
     */
    readonly reason: "explicit" | "killed" | "device-lost";
    /** ADR 0003 §8: the released lease's owner, so a `lease-lost` push can be routed to every
     * live connection whose principal owns it -- the registry no longer has the lease to look
     * this up from by the time this event fires (`beginRelease` already removed it), so it
     * travels on the event instead. */
    readonly ownerId: string;
  };
  "lease.expired": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly ownerId: string;
  };
  "lease.rejected": {
    /** The request's id. A request refused at admission (`killed`, `already-leased`, `lease-id-taken`) was never
     * stored and has no `lease.requested`, but it carries the id it would have been stored
     * under. A gateway's `lease-id-taken` can also follow a grant (a worker's lease whose ID the
     * gateway already routes elsewhere): that request was stored and has its `lease.requested`. */
    readonly requestId: string;
    readonly requester: string;
    /** The request as it arrived, as on `lease.requested`: `class` when it named one, `model`
     * only when it did (ADR 0015 §9). */
    readonly requestSpec: unknown;
    readonly reason:
      | "timeout"
      | "no-wait"
      | "unresolvable-spec"
      /** A gateway's request that no worker taking requests can serve (ADR 0009 §4). */
      | "no-worker"
      | "already-leased"
      /** The request named a lease ID an active lease or a waiting request holds (ADR 0020). */
      | "lease-id-taken"
      | "boot-timeout"
      | "killed"
      | "cancelled"
      /** A request still open when the daemon stopped, settled as failed at the next start. */
      | "daemon-restarted";
  };
  /**
   * A worker's capacity figures changed. Emitted after every registry commit and every
   * reservation taken or released that changes them, and once at startup; never twice in a
   * row with equal figures. `ramBudget` is there only under a strategy that keeps one.
   */
  "capacity.changed": {
    readonly ios: CapacityFiguresPayload;
    readonly android: CapacityFiguresPayload;
    readonly global: CapacityFiguresPayload;
    readonly ramBudget?: { readonly usedBytes: number; readonly limitBytes: number };
  };
  /** The depth of a wait queue changed (a worker's, or a gateway's fleet queue), and once at
   * startup. */
  "queue.changed": { readonly depth: number };
  "device.provisioned": {
    readonly deviceId: string;
    readonly spec: unknown;
    readonly driver: string;
    readonly duration: number;
  };
  "device.ready": { readonly deviceId: string; readonly bootDuration: number };
  "device.reclaimed": {
    readonly deviceId: string;
    readonly strategy: "erase" | "snapshot" | "wipe";
    readonly duration: number;
  };
  "device.purge-failed": {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly attemptedStrategy: string;
    readonly duration: number;
    readonly error: string;
  };
  "device.crash-detected": {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly platform: string;
    readonly observed: string;
  };
  "device.recovered": {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly attempts: number;
    readonly duration: number;
  };
  "device.recovery-failed": {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly attempts: number;
    readonly reason: string;
    readonly error: string;
  };
  "device.quarantined": {
    readonly deviceId: string;
    readonly maxRetries: number;
    readonly nextRetryAt: number;
  };
  "device.quarantine-recovered": {
    readonly deviceId: string;
    readonly attempts: number;
    readonly strategy: "erase" | "snapshot" | "wipe";
  };
  "device.quarantine-abandoned": { readonly deviceId: string; readonly attempts: number };
  "device.quarantine-stranded": {
    readonly deviceId: string;
    readonly attempts: number;
    readonly error: string;
  };
  "device.orphan-purged": {
    readonly driverDeviceId: string;
    readonly platform: string;
    readonly deviceRoot: string;
  };
  "device.shutdown": { readonly deviceId: string; readonly initiator: string };
  "device.deleted": { readonly deviceId: string; readonly initiator: string };
  "device.slimmed": {
    readonly deviceId: string;
    readonly address: string;
    readonly platform: "ios";
    readonly categories: readonly string[];
    readonly labelCount: number;
    readonly durationMs: number;
    readonly signature: string;
    readonly unknownLabels: readonly string[];
  };
  "component.install-started": {
    readonly platform: string;
    /** The component string the install was asked for: a version, or a driver's word for newest. */
    readonly componentId: string;
    /** The requester whose call started this install, when one is known. */
    readonly requesterId?: string;
  };
  "component.installed": {
    readonly platform: string;
    readonly componentId: string;
    /** The exact version now installed. */
    readonly version: string;
    /** True when the installer ran and the component was already there; nothing was recorded. */
    readonly alreadyPresent: boolean;
    readonly durationMs: number;
    readonly requesterId?: string;
  };
  "component.install-failed": {
    readonly platform: string;
    readonly componentId: string;
    readonly durationMs: number;
    readonly error: string;
    readonly requesterId?: string;
  };
  "component.removed": {
    readonly platform: string;
    /** The component string the removal was asked for: the version, as the catalog lists it. */
    readonly componentId: string;
    /** The exact version removed: the version of Simlock's record of installing it. */
    readonly version: string;
    /** The component's size as listed just before it was removed, when the driver could read it. */
    readonly sizeBytes?: number;
    /** What stayed on disk after the removal, and how to reclaim it, when something did. */
    readonly residue?: string;
    /** The principal of the admin session that asked. */
    readonly requesterId: string;
  };
  "daemon.started": { readonly version: string; readonly configSnapshot: unknown };
  "daemon.stopping": { readonly reason: string };
  "disk.pressure-detected": { readonly freeBytes: number; readonly threshold: number };
  "device.foreign-provenance-detected": {
    readonly deviceId: string;
    readonly platform: string;
    readonly detail: string;
  };
  "device.foreign-state-detected": {
    readonly deviceId: string;
    readonly platform: string;
    readonly expected: string;
    readonly observed: string;
  };
  "device.stalled-transition-detected": {
    readonly deviceId: string;
    readonly platform: string;
    readonly state: string;
    readonly ageMs: number;
    readonly thresholdMs: number;
  };
  "cleanup.executed": {
    readonly ruleName: string;
    readonly action: string;
    readonly target: string;
    readonly reason: string;
  };
  "doctor.reconciled": { readonly driftFindings: unknown };
  /**
   * A warm pool target that was met, or not yet checked, ends a pass short for a reason: the pass
   * could do nothing for it. Emitted once per kind of device on that edge (targets that resolve to one spec emit one event
   * between them), not on each short pass after.
   */
  "warm-pool.target-missed": {
    readonly platform: string;
    readonly model: string;
    /** Absent for a target that names none and did not resolve. */
    readonly osVersion?: string;
    readonly mode: "slim" | "full";
    readonly count: number;
    readonly ready: number;
    /** Why it is short: the first of the reasons that apply (`docs/EVENTS.md`). */
    readonly reason: string;
  };
  // ---- gateway facts (ADR 0005 §22) ---------------------------------------------------------
  //
  // Emitted only by a daemon in gateway mode, about the workers connected to it. A worker's own
  // events are *republished* on the gateway's bus under their original names with `workerId`
  // added to the payload, so `simlock events` against a gateway shows the fleet; these six are
  // the facts only the gateway can know.
  /** A worker's uplink opened and its `hello` completed: the gateway can now drive it. An
   * uplink that authenticated but negotiated no protocol emits nothing at all (ADR 0005 §31):
   * it is in the registry as `incompatible`, which is where an operator finds it. */
  "worker.connected": {
    readonly workerId: string;
    readonly label?: string;
    readonly version?: string;
  };
  /**
   * An uplink was turned away at the door, before any session existed (ADR 0005 §4/§22).
   * Two reasons, and they are the same two the rest of the API tells apart:
   * `unauthenticated` (`401`) is a missing or unrecognized join token -- a revoked or mistyped
   * one lands here -- and `forbidden` (`403`) is a real token whose role is not `worker`.
   *
   * Version skew is deliberately *not* one of these: a worker whose `hello` finds no
   * overlapping protocol range authenticated fine, so it enters the registry as
   * `incompatible` and emits nothing (§31). This event is only ever about the door.
   *
   * Every field but `reason` is optional because a dial that fails authentication proves no
   * identity: `workerId` and `label` are whatever the connection *claimed* in its headers, and
   * may be absent entirely.
   *
   * P-2: `count`, present only when greater than one, is how many identical (reason, claimed
   * id) refusals the *previous* coalescing window absorbed before it closed, reported on the
   * next matching refusal rather than this event's own (always singular) occurrence.
   * `GatewayService` coalesces a flood of these into one emission per window rather than one per
   * dial, since every refusal here is unauthenticated by definition and the ring buffer they
   * land in is bounded by count, not bytes (P3): without coalescing, a loop of refused dials can
   * evict every other fact an operator comes to `simlock events` for, including the very
   * `worker.connected`/`worker.disconnected` lines explaining whatever outage they are
   * debugging.
   */
  "worker.rejected": {
    readonly reason: "forbidden" | "unauthenticated";
    readonly workerId?: string;
    readonly label?: string;
    readonly count?: number;
  };
  /** A worker's uplink closed. `leaseCount` is what the view still shows it holding at that
   * moment -- the number an operator needs to know how much is stranded, and the reason the
   * view is not dropped immediately (§6). */
  "worker.disconnected": {
    readonly workerId: string;
    readonly label?: string;
    readonly leaseCount: number;
  };
  /** A disconnected worker's view was forgotten: by an operator (`worker.remove`) or because
   * `gateway.disconnectedRetentionMs` elapsed. */
  "worker.removed": {
    readonly workerId: string;
    readonly label?: string;
    readonly reason: "operator" | "retention";
  };
  /** ADR 0005 §9: the worker keeps its leases and receives no new dispatches from here on. */
  "worker.drain-started": { readonly workerId: string; readonly label?: string };
  "worker.drain-ended": { readonly workerId: string; readonly label?: string };
  /**
   * ADR 0005 §11/§22 (#118): the gateway's own dispatch sent a queued request to a worker and
   * the worker took it (a grant, or the first `progress` push, whichever came first -- device
   * work having started means the request is that worker's now). A `NO_CAPACITY` refusal is a
   * stale view, not a dispatch, and emits nothing -- the request stays queued, or a `noWait`
   * request gets one more walk without that worker (ADR 0009 §5).
   *
   * C2 (round 2 review): widened back to what `docs/internal/EVENTS.md` always specified for this row --
   * `requesterId`/`platform`/`model` so the fact is self-contained (events rule 6) rather than
   * naming only the gateway-internal `requestId`, `reason` (the routing policy's own warm-hit /
   * free-capacity distinction, already computed by `RoutingPolicy#select` and previously
   * discarded rather than plumbed through), and `queuedMs` (time spent queued before this
   * dispatch). `reason` is spelled out as a literal union here rather than importing
   * `RoutingReason` from `src/gateway/routing.ts`: this module stays platform- and
   * gateway-agnostic (`architecture.md`), so a payload shape is duplicated rather than an import
   * reaching up into a module layered above it.
   */
  "request.dispatched": {
    readonly requestId: string;
    readonly workerId: string;
    readonly requesterId: string;
    readonly platform: string;
    /** The exact model the request named; absent for a class request (ADR 0015 §9). */
    readonly model?: string;
    /** The class the request named; absent for an exact one or one naming neither. */
    readonly class?: string;
    /** The mode the request named (ADR 0009 §8); absent when it named none. */
    readonly mode?: "slim" | "full";
    readonly reason: "warm-hit" | "free-capacity";
    /** The routing stage that decided the pick (ADR 0009 §8). */
    readonly stage: string;
    readonly queuedMs: number;
  };
  /** Payloads owned by the driver module that refused the root; see `DriverRejection`. */
  "driver.root-rejected": {
    readonly platform: string;
    readonly root: string;
    readonly reason: string;
  };
  "driver.adb-server-rejected": { readonly port: number; readonly reason: string };
}

export type EventName = keyof EventMap;

export type EventEnvelope<Event extends EventName = EventName> = Event extends EventName
  ? {
      /** Names this event for good: minted once where it happened, it survives a restart and is
       * what every reader tells events apart by (ADR 0014). `seq` only orders within one run. */
      readonly id: string;
      readonly seq: number;
      readonly timestamp: number;
      readonly event: Event;
      readonly payload: EventMap[Event];
      readonly module: string;
    }
  : never;

/** An envelope before a bus gives it a `seq`: everything the place the fact happened stamped. */
export interface StampedEnvelope<Event extends EventName = EventName> {
  readonly id: string;
  readonly timestamp: number;
  readonly event: Event;
  readonly payload: EventMap[Event];
  readonly module: string;
}

export type EventHandler<Event extends EventName> = (envelope: EventEnvelope<Event>) => void;
export type AllEventHandler = (envelope: EventEnvelope) => void;

export interface EventBusLogger {
  error(
    message: string,
    details: { readonly error: unknown; readonly envelope: EventEnvelope },
  ): void;
}

const defaultLogger: EventBusLogger = {
  error(message, details) {
    console.error(message, details);
  },
};

export class EventBus {
  #nextSequence = 1;
  readonly #subscribers = new Map<EventName, Set<EventHandler<EventName>>>();
  readonly #allSubscribers = new Set<AllEventHandler>();
  readonly #events: Array<EventEnvelope | undefined>;
  #nextEventIndex = 0;
  #eventCount = 0;

  constructor(
    private readonly clock: Clock,
    private readonly capacity = 1_000,
    private readonly logger: EventBusLogger = defaultLogger,
    private readonly idGenerator: IdGenerator = new CryptoIdGenerator(),
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Event bus capacity must be a positive integer");
    }
    this.#events = Array.from({ length: capacity }, () => undefined);
  }

  emit<Event extends EventName>(
    event: Event,
    payload: EventMap[Event],
    module: string,
  ): EventEnvelope<Event> {
    return this.#publish({
      id: `evt_${this.idGenerator.generate()}`,
      timestamp: this.clock.now(),
      event,
      payload,
      module,
    });
  }

  /**
   * Publishes an envelope whose fact happened elsewhere (ADR 0014 §2): it keeps the `id` and
   * `timestamp` it was stamped with and gets only this bus's next `seq`. Reaches the ring and
   * every subscriber exactly as `emit` does. Not a second way to state a fact -- the gateway's
   * worker link is its one caller, relaying what a worker already stated.
   */
  republish<Event extends EventName>(envelope: StampedEnvelope<Event>): EventEnvelope<Event> {
    return this.#publish(envelope);
  }

  #publish<Event extends EventName>(stamped: StampedEnvelope<Event>): EventEnvelope<Event> {
    const envelope = { ...stamped, seq: this.#nextSequence } as EventEnvelope<Event>;
    this.#nextSequence += 1;
    this.#append(envelope);

    const subscribers = [...(this.#subscribers.get(envelope.event) ?? [])];
    const allSubscribers = [...this.#allSubscribers];
    for (const subscriber of subscribers) {
      this.#dispatch(subscriber, envelope);
    }
    for (const subscriber of allSubscribers) {
      this.#dispatch(subscriber, envelope);
    }

    return envelope;
  }

  subscribe<Event extends EventName>(event: Event, handler: EventHandler<Event>): () => void {
    const subscribers = this.#subscribers.get(event) ?? new Set<EventHandler<EventName>>();
    subscribers.add(handler as EventHandler<EventName>);
    this.#subscribers.set(event, subscribers);

    return () => {
      subscribers.delete(handler as EventHandler<EventName>);
      if (subscribers.size === 0 && this.#subscribers.get(event) === subscribers) {
        this.#subscribers.delete(event);
      }
    };
  }

  subscribeAll(handler: AllEventHandler): () => void {
    this.#allSubscribers.add(handler);
    return () => this.#allSubscribers.delete(handler);
  }

  replay({
    sinceSeq,
    sinceTs,
  }: { readonly sinceSeq?: number; readonly sinceTs?: number } = {}): EventEnvelope[] {
    return this.#retainedEvents()
      .filter(
        (event) =>
          (sinceSeq === undefined || event.seq > sinceSeq) &&
          (sinceTs === undefined || event.timestamp > sinceTs),
      )
      .sort(byTimeThenSeq);
  }

  #append(envelope: EventEnvelope): void {
    this.#events[this.#nextEventIndex] = envelope;
    this.#nextEventIndex = (this.#nextEventIndex + 1) % this.capacity;
    if (this.#eventCount < this.capacity) {
      this.#eventCount += 1;
    }
  }

  #retainedEvents(): EventEnvelope[] {
    const oldestEventIndex = this.#eventCount === this.capacity ? this.#nextEventIndex : 0;
    const events: EventEnvelope[] = [];

    for (let index = 0; index < this.#eventCount; index += 1) {
      const event = this.#events[(oldestEventIndex + index) % this.capacity];
      if (event !== undefined) {
        events.push(event);
      }
    }

    return events;
  }

  #dispatch(handler: (envelope: EventEnvelope) => void, envelope: EventEnvelope): void {
    try {
      handler(envelope);
    } catch (error: unknown) {
      try {
        this.logger.error("Event handler failed", { error, envelope });
      } catch {
        // Logging must not break event delivery.
      }
    }
  }
}

export {
  EVENT_FILE_NAME,
  EventHistory,
  eventKey,
  readEventFile,
  readEventHistory,
} from "./event-file.js";
