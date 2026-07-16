import type { Clock } from "../ports/index.js";

export interface EventMap {
  "lease.requested": {
    readonly requestSpec: unknown;
    readonly requester: string;
    readonly waitPolicy: string;
  };
  "lease.queued": { readonly requestId: string; readonly queuePosition: number };
  "lease.granted": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly requester: string;
    readonly mode: "held" | "detached";
  };
  "lease.renewed": { readonly leaseId: string; readonly newDeadline: number };
  "lease.released": {
    readonly leaseId: string;
    readonly deviceId: string;
    readonly reason: "closed" | "explicit" | "killed";
  };
  "lease.expired": { readonly leaseId: string; readonly deviceId: string };
  "lease.rejected": {
    readonly requestSpec: unknown;
    readonly reason: "timeout" | "no-wait" | "unresolvable-spec";
  };
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
  "device.shutdown": { readonly deviceId: string; readonly initiator: string };
  "device.deleted": { readonly deviceId: string; readonly initiator: string };
  "runtime.deleted": { readonly runtimeId: string; readonly initiator: string };
  "daemon.started": { readonly version: string; readonly configSnapshot: unknown };
  "daemon.stopping": { readonly reason: string };
  "disk.pressure-detected": { readonly freeBytes: number; readonly threshold: number };
  "cleanup.executed": {
    readonly ruleName: string;
    readonly action: string;
    readonly target: string;
    readonly reason: string;
  };
  "doctor.reconciled": { readonly driftFindings: unknown };
}

export type EventName = keyof EventMap;

export type EventEnvelope<Event extends EventName = EventName> = Event extends EventName
  ? {
      readonly seq: number;
      readonly timestamp: number;
      readonly event: Event;
      readonly payload: EventMap[Event];
      readonly module: string;
    }
  : never;

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
    const envelope = {
      seq: this.#nextSequence,
      timestamp: this.clock.now(),
      event,
      payload,
      module,
    } as EventEnvelope<Event>;
    this.#nextSequence += 1;
    this.#append(envelope);

    const subscribers = [...(this.#subscribers.get(event) ?? [])];
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
    return this.#retainedEvents().filter(
      (event) =>
        (sinceSeq === undefined || event.seq > sinceSeq) &&
        (sinceTs === undefined || event.timestamp > sinceTs),
    );
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
