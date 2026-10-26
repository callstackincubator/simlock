import { type Clock, CryptoIdGenerator, type IdGenerator } from "../ports/index.js";
import { byTimeThenSeq } from "./order.js";

export interface CapacityFiguresPayload {
  readonly running: number;
  readonly maxRunning: number;
  readonly reserved: number;
  readonly warm: number;
}

/** why: each reason points an operator at a different fix: the token, its role, or the worker it is pinned to. */
export type WorkerRejectedReason = "unauthenticated" | "forbidden" | "worker-mismatch";

export interface EventMap {
  "lease.requested": {
    readonly requestId: string;
    readonly requestSpec: unknown;
    readonly requester: string;
    readonly waitPolicy: string;
    readonly fleetRequestId?: string;
  };
  "lease.queued": { readonly requestId: string; readonly queuePosition: number };
  "lease.granted": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly requester: string;
    readonly requestId: string;
    readonly source: "warm" | "booted" | "provisioned";
    readonly fleetRequestId?: string;
    // why: events stored before this field existed lack it and a rebuild replays them, so the projector reads it as optional.
    readonly platform: "ios" | "android";
  };
  "lease.renewed": { readonly leaseId: string; readonly newDeadline: number };
  "lease.released": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly reason: "explicit" | "killed" | "device-lost";
    /** why: ADR 0003 §8: the released lease's owner, so a `lease-lost` push can be routed to every
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
    readonly requestId: string;
    readonly requester: string;
    readonly requestSpec: unknown;
    readonly reason:
      | "timeout"
      | "no-wait"
      | "unresolvable-spec"
      | "no-worker"
      | "already-leased"
      | "lease-id-taken"
      | "boot-timeout"
      | "killed"
      | "updating"
      | "cancelled"
      | "daemon-restarted"
      | "worker-failed";
    readonly code?: string;
    /** why: On `worker-failed`: the worker the request failed on. Named `worker`, never `workerId`,
     * because `payload.workerId` marks a relayed event (ADR 0014 §6). */
    readonly worker?: string;
  };
  /**
   * why: ADR 0021 §2: a worker refused or failed a gateway dispatch (a probe). The gateway owns that
   * request's outcome, so the worker never rejects it. `reason` takes `lease.rejected`'s values.
   */
  "lease.declined": {
    readonly requestId: string;
    readonly fleetRequestId: string;
    readonly requester: string;
    readonly requestSpec: unknown;
    readonly reason: EventMap["lease.rejected"]["reason"];
  };
  "request.granted": {
    readonly requestId: string;
    readonly worker: string;
    readonly leaseId: string;
    readonly workerLeaseId: string;
  };
  "capacity.changed": {
    readonly ios: CapacityFiguresPayload;
    readonly android: CapacityFiguresPayload;
    readonly global: CapacityFiguresPayload;
    readonly ramBudget?: { readonly usedBytes: number; readonly limitBytes: number };
  };
  "queue.changed": {
    readonly depth: number;
    readonly physical?: true;
  };
  "device.provisioned": {
    readonly deviceId: string;
    readonly spec: unknown;
    readonly driver: string;
    readonly duration: number;
  };
  "device.ready": {
    readonly deviceId: string;
    readonly bootDuration: number;
    readonly platform: "ios" | "android";
  };
  "device.reclaimed": {
    readonly deviceId: string;
    readonly strategy: "erase" | "snapshot" | "wipe" | "uninstall";
    readonly missingApps?: readonly string[];
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
    readonly platform: "ios" | "android";
  };
  "device.recovery-failed": {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly attempts: number;
    readonly reason: string;
    readonly error: string;
    readonly platform: "ios" | "android";
  };
  "device.quarantined": {
    readonly deviceId: string;
    readonly maxRetries: number;
    readonly nextRetryAt: number;
    readonly platform: "ios" | "android";
    readonly kind: "purge-failed" | "shutdown-failed" | "delete-failed" | "stalled";
    readonly stalledState?: "provisioning" | "reclaiming" | undefined;
    readonly message?: string | undefined;
  };
  "device.absence-detected": {
    readonly deviceId: string;
    readonly previousState: "ready" | "leased" | "reclaiming";
    readonly absentReason: "locked" | "untrusted" | "not-present";
  };
  "device.returned": { readonly deviceId: string; readonly osVersion: string };
  "device.quarantine-recovered": {
    readonly deviceId: string;
    readonly attempts: number;
    readonly strategy: "erase" | "snapshot" | "wipe" | "uninstall";
    readonly missingApps?: readonly string[];
    readonly platform: "ios" | "android";
  };
  "device.quarantine-abandoned": {
    readonly deviceId: string;
    readonly attempts: number;
    readonly platform: "ios" | "android";
  };
  "device.quarantine-stranded": {
    readonly deviceId: string;
    readonly attempts: number;
    readonly error: string;
    readonly platform: "ios" | "android";
  };
  "device.orphan-purged": {
    readonly driverDeviceId: string;
    readonly platform: string;
    readonly deviceRoot: string;
  };
  "device.shutdown": { readonly deviceId: string; readonly initiator: string };
  "device.deleted": {
    readonly deviceId: string;
    readonly initiator: string;
    readonly physical: boolean;
  };
  "device.enrolled": {
    readonly deviceId: string;
    readonly platform: string;
    readonly driverDeviceId: string;
    readonly model: string;
    readonly osVersion: string;
    readonly class: "phone" | "tablet";
    readonly appCount: number;
    readonly reenrolled: boolean;
  };
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
    readonly componentId: string;
    readonly requesterId?: string;
  };
  "component.installed": {
    readonly platform: string;
    readonly componentId: string;
    readonly version: string;
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
    readonly componentId: string;
    readonly version: string;
    readonly sizeBytes?: number;
    readonly residue?: string;
    readonly requesterId: string;
  };
  "daemon.started": { readonly version: string; readonly configSnapshot: unknown };
  "daemon.stopping": { readonly reason: string };
  "daemon.update-failed": {
    readonly stage: "installing" | "restarting";
    readonly from: string;
    readonly to: string;
    readonly message: string;
  };
  "daemon.update-started": {
    readonly from: string;
    readonly to: string;
    readonly forced: boolean;
  };
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
  "warm-pool.target-missed": {
    readonly platform: string;
    readonly model: string;
    readonly osVersion?: string;
    readonly mode: "slim" | "full";
    readonly origin: "configured";
    readonly count: number;
    readonly ready: number;
    /** why: one reason, not all: the first of the reasons the target is short that applies. */
    readonly reason: string;
  };
  "worker.connected": {
    readonly workerId: string;
    readonly label?: string;
    readonly version?: string;
  };
  /**
   * why: an uplink turned away at the door leaves no other trace (ADR 0005 §4/§22).
   * `unauthenticated` (`401`) is a missing or unrecognized join token -- a revoked or mistyped
   * one lands here; `forbidden` (`403`) is a real token whose role is not `worker`; and
   * `worker-mismatch` (`403`) is a join token pinned to another worker id, or a worker id
   * another token is pinned to.
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
    readonly reason: WorkerRejectedReason;
    readonly workerId?: string;
    readonly label?: string;
    readonly count?: number;
  };
  "worker.disconnected": {
    readonly workerId: string;
    readonly label?: string;
    readonly leaseCount: number;
  };
  "worker.removed": {
    readonly workerId: string;
    readonly label?: string;
    readonly reason: "operator" | "retention";
  };
  "worker.drain-started": { readonly workerId: string; readonly label?: string };
  "worker.drain-ended": { readonly workerId: string; readonly label?: string };
  "request.dispatched": {
    readonly requestId: string;
    readonly workerId: string;
    readonly requesterId: string;
    readonly platform: string;
    readonly model?: string;
    readonly class?: string;
    readonly mode?: "slim" | "full";
    readonly physical?: true;
    readonly reason: "warm-hit" | "free-capacity";
    readonly stage: string;
    readonly queuedMs: number;
  };
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
      readonly id: string;
      readonly seq: number;
      readonly timestamp: number;
      readonly event: Event;
      readonly payload: EventMap[Event];
      readonly module: string;
    }
  : never;

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
        // why: Logging must not break event delivery.
      }
    }
  }
}

export function eventKey(event: { readonly id: string }): string {
  return event.id;
}
