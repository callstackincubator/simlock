import type { EventEnvelope } from "../../bus/index.js";
import type { UsageFigures } from "../../contract/index.js";
import type { Step } from "./timeline.js";

/**
 * Reads a window's events into the facts the figures count (ADR 0016 §2, ADR 0021 §5): one fact
 * for each request, one for each device event that counts, one for each decline, and the capacity
 * and queue steps. Nothing here adds a number up.
 */

export type Platform = "ios" | "android";

export interface RequestFact {
  readonly requester: string;
  readonly platform: Platform | undefined;
  /** The worker that served it: a worker's own, or the one a gateway dispatched it to. */
  readonly worker: string | undefined;
  /** `undefined` for a rejection refused before the request was stored, which is no request. */
  readonly requestedAt: number | undefined;
  /** On a worker: a gateway's dispatch (ADR 0021 §1), which gives no wait, turnaround, request or
   * rejection. Absent otherwise. */
  readonly probe?: true;
  readonly outcome?: Granted | Rejected;
  /** How long the lease was held, when the window saw both its grant and its end. Both are the
   * clock of the host that granted it, so on a gateway it is not `outcome.at` to an end. */
  readonly heldMs?: number;
}

type RequestFactBase = Pick<RequestFact, "platform" | "probe" | "requestedAt" | "requester">;

interface Granted {
  readonly kind: "granted";
  readonly at: number;
  /** `unknown` on a gateway for a grant whose worker's own `lease.granted` was not relayed. */
  readonly source: string;
}

interface Rejected {
  readonly kind: "rejected";
  readonly at: number;
  readonly reason: string;
}

export interface DeviceFact {
  readonly kind: "provisioning" | "boot" | "incident" | "failure";
  readonly worker: string | undefined;
  readonly platform: Platform | undefined;
  /** The duration for the first two, the incident name or the failure event name for the others. */
  readonly value: number | string;
}

/** One `lease.declined` (ADR 0021 §2): a worker's refusal of a gateway dispatch. Not a request. */
export interface DeclineFact {
  readonly worker: string;
  readonly platform: Platform | undefined;
}

export interface CapacityValue {
  readonly used: number;
  readonly max: number;
  readonly ram: { readonly used: number; readonly limit: number } | undefined;
}

export type CapacityStep = Step<
  CapacityValue & { readonly platforms: Readonly<Record<Platform, CapacityValue>> }
>;

export interface ReadEvents {
  readonly requests: readonly RequestFact[];
  /**
   * Requests with no outcome by the window's start, which only the series counts: ones made
   * before the window and still open when it began, and a gateway's requests that a restart
   * before the window's end ended (outcome `daemon-restarted`).
   */
  readonly carried: readonly RequestFact[];
  readonly devices: readonly DeviceFact[];
  readonly declines: readonly DeclineFact[];
  readonly capacity: readonly CapacityStep[];
  readonly queue: readonly Step<number>[];
  readonly workers: ReadonlySet<string>;
}

export interface ReadOptions {
  readonly fleet: boolean;
  /** The `requestId` of every request made before the window. */
  readonly requestedBefore: ReadonlySet<string>;
  /** The `requestId` of every request answered before the window: granted or rejected. */
  readonly answeredBefore: ReadonlySet<string>;
  /** The id a worker's own events are attributed to. */
  readonly self: string;
}

export interface UsageWindow {
  readonly from: number;
  readonly to: number;
}

type Payload = Readonly<Record<string, unknown>>;
type Incident = keyof UsageFigures["incidents"];

/** A rejection with no `lease.requested` anywhere in the history read was refused before the
 * request was stored; only these reasons are ever given before admission. One whose request
 * is in the history follows that request: counted with it, or in no count when it was made before
 * the window. */
const REFUSED_AT_ADMISSION = new Set(["already-leased", "killed", "lease-id-taken"]);
/** The device events that count as an incident, by what the figure calls them. */
const INCIDENT_OF: Readonly<Record<string, Incident>> = {
  "device.quarantine-abandoned": "lost",
  "device.quarantine-recovered": "quarantineRecovered",
  "device.quarantine-stranded": "lost",
  "device.quarantined": "quarantined",
  "device.recovered": "crashRecovered",
  "device.recovery-failed": "lost",
};
/** A failure is any event named `*-failed`, counted by its name. */
const isFailure = (event: string): boolean => event.endsWith("-failed");

const text = (payload: Payload, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
};

const number = (payload: Payload, key: string): number | undefined => {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const platformOf = (value: unknown): Platform | undefined =>
  value === "ios" || value === "android" ? value : undefined;

const objectOf = (value: unknown): Payload | undefined =>
  typeof value === "object" && value !== null ? (value as Payload) : undefined;

interface RelayedGrant {
  readonly at: number;
  readonly index: number;
  readonly source: string;
}

interface Request {
  readonly index: number;
  readonly at: number;
  readonly requester: string;
  readonly platform: Platform | undefined;
  readonly probe: boolean;
}

/** What one event brings to a handler. */
interface Seen {
  readonly event: EventEnvelope;
  readonly index: number;
  readonly payload: Payload;
  /** The worker the fact is about: a worker's own id, or on a gateway the one that relayed it. */
  readonly worker: string | undefined;
  /** A gateway's own fact, as against one a worker relayed. Always true on a worker. */
  readonly own: boolean;
  readonly within: boolean;
}

type OwnRejection = Omit<Rejected, "kind"> & {
  readonly requester: string;
  readonly platform: Platform | undefined;
  /** The worker a `worker-failed` rejection names. */
  readonly worker: string | undefined;
};

export function readEvents(
  sorted: readonly EventEnvelope[],
  window: UsageWindow,
  options: ReadOptions,
): ReadEvents {
  const reader = new Reader(window, options);
  sorted.forEach((event, index) => reader.see(event, index));
  return reader.finish();
}

class Reader {
  readonly #devices: DeviceFact[] = [];
  readonly #declines: DeclineFact[] = [];
  readonly #capacity: CapacityStep[] = [];
  readonly #queue: Step<number>[] = [];
  readonly #workers = new Set<string>();
  readonly #devicePlatform = new Map<string, Platform>();
  readonly #requested = new Map<string, Request>();
  /** The latest request of each requester made before the window. */
  readonly #carriedRequests = new Map<string, Request & { readonly requestId: string }>();
  readonly #ownRejections = new Map<string, OwnRejection>();
  /** A worker's own grants by request id: the lease each served. */
  readonly #grants = new Map<
    string,
    {
      readonly at: number;
      readonly index: number;
      readonly leaseId: string;
      readonly source: string;
    }
  >();
  /** A gateway's `request.granted` by request id (ADR 0021 §4). */
  readonly #handed = new Map<
    string,
    { readonly at: number; readonly worker: string; readonly workerLeaseId: string }
  >();
  /**
   * The grants workers relayed to a gateway, by worker and the worker's lease id, in event order.
   * A lease id is unique only while its lease is active (ADR 0020), so one key can hold several.
   */
  readonly #relayedGrants = new Map<string, RelayedGrant[]>();
  /** The ends of leases, by worker and lease id, in event order: a key can hold several. */
  readonly #ends = new Map<string, { readonly at: number; readonly index: number }[]>();
  /** Where the gateway's own `daemon.started` events fall, in event order (ADR 0021 §5). */
  readonly #restarts: { readonly index: number; readonly at: number }[] = [];
  readonly #handlers: Record<string, (seen: Seen) => void> = {
    "capacity.changed": (seen) => this.#capacityChanged(seen),
    "daemon.started": (seen) => this.#daemonStarted(seen),
    "device.provisioned": (seen) => this.#provisioned(seen),
    "device.ready": (seen) => this.#ready(seen),
    "lease.declined": (seen) => this.#declined(seen),
    "lease.expired": (seen) => this.#ended(seen),
    "lease.granted": (seen) => this.#granted(seen),
    "lease.rejected": (seen) => this.#rejected(seen),
    "lease.released": (seen) => this.#ended(seen),
    "lease.requested": (seen) => this.#leaseRequested(seen),
    "queue.changed": (seen) => this.#queueChanged(seen),
    "request.granted": (seen) => this.#requestGranted(seen),
  };

  constructor(
    private readonly window: UsageWindow,
    private readonly options: ReadOptions,
  ) {}

  see(event: EventEnvelope, index: number): void {
    const payload = (event.payload ?? {}) as Payload;
    const relayedFrom = text(payload, "workerId");
    const seen: Seen = {
      event,
      index,
      own: !this.options.fleet || relayedFrom === undefined,
      payload,
      within: event.timestamp > this.window.from && event.timestamp <= this.window.to,
      worker: this.options.fleet ? relayedFrom : this.options.self,
    };
    (this.#handlers[event.event] ?? ((other) => this.#deviceEvent(other)))(seen);
  }

  finish(): ReadEvents {
    return {
      capacity: this.#capacity,
      carried: this.#carriedOpen(),
      declines: this.#declines,
      devices: this.#devices,
      queue: this.#queue,
      requests: [...this.#requests(), ...this.#refusedAtAdmission()],
      workers: this.#workers,
    };
  }

  #key(worker: string, id: string): string {
    return `${worker}\u0000${id}`;
  }

  /** On a gateway a device fact needs a worker behind it; on a worker it is always its own. */
  #counts(seen: Seen): seen is Seen & { readonly worker: string } {
    return seen.within && (!this.options.fleet || seen.worker !== undefined);
  }

  #capacityChanged(seen: Seen): void {
    const { event, payload, worker } = seen;
    if (event.timestamp > this.window.to || worker === undefined) return;
    const step = capacityStep(payload, event.timestamp, worker);
    if (step !== undefined) this.#capacity.push(step);
    this.#workers.add(worker);
  }

  #queueChanged(seen: Seen): void {
    const depth = number(seen.payload, "depth");
    if (seen.event.timestamp > this.window.to || !seen.own || depth === undefined) return;
    this.#queue.push({ at: seen.event.timestamp, key: "queue", value: depth });
  }

  #leaseRequested(seen: Seen): void {
    if (!seen.own) return;
    const requestId = text(seen.payload, "requestId");
    const requester = text(seen.payload, "requester");
    if (requestId === undefined || requester === undefined) return;
    const request: Request = {
      at: seen.event.timestamp,
      index: seen.index,
      platform: requestPlatform(seen.payload),
      probe: !this.options.fleet && text(seen.payload, "fleetRequestId") !== undefined,
      requester,
    };
    if (seen.event.timestamp <= this.window.from) {
      this.#carriedRequests.set(requester, { ...request, requestId });
    }
    if (seen.within) this.#requested.set(requestId, request);
  }

  /** A gateway's restart ends every fleet request still without an outcome (ADR 0021 §5). */
  #daemonStarted(seen: Seen): void {
    if (!this.options.fleet || !seen.own || seen.event.timestamp > this.window.to) return;
    this.#restarts.push({ at: seen.event.timestamp, index: seen.index });
  }

  /** A gateway's own `request.granted` is its fleet request's grant. */
  #requestGranted(seen: Seen): void {
    const requestId = text(seen.payload, "requestId");
    const worker = text(seen.payload, "worker");
    const workerLeaseId = text(seen.payload, "workerLeaseId");
    if (!this.options.fleet || !seen.own || !seen.within) return;
    if (requestId === undefined || worker === undefined || workerLeaseId === undefined) return;
    this.#handed.set(requestId, { at: seen.event.timestamp, worker, workerLeaseId });
  }

  /** A worker's `lease.declined`, or one a gateway's worker relayed: an event, never a request. */
  #declined(seen: Seen): void {
    if (!seen.within || seen.worker === undefined) return;
    this.#declines.push({ platform: requestPlatform(seen.payload), worker: seen.worker });
    this.#workers.add(seen.worker);
  }

  #rejected(seen: Seen): void {
    const requestId = text(seen.payload, "requestId");
    const reason = text(seen.payload, "reason");
    const requester = text(seen.payload, "requester");
    if (!seen.within || !seen.own) return;
    if (requestId === undefined || reason === undefined || requester === undefined) return;
    this.#ownRejections.set(requestId, {
      at: seen.event.timestamp,
      platform: requestPlatform(seen.payload),
      reason,
      requester,
      worker: reason === "worker-failed" ? text(seen.payload, "worker") : undefined,
    });
  }

  #granted(seen: Seen): void {
    if (!seen.within) return;
    const leaseId = text(seen.payload, "leaseId");
    if (leaseId === undefined) return;
    const source = text(seen.payload, "source") ?? "";
    if (this.options.fleet) {
      if (seen.worker !== undefined) {
        const key = this.#key(seen.worker, leaseId);
        const earlier = this.#relayedGrants.get(key) ?? [];
        earlier.push({ at: seen.event.timestamp, index: seen.index, source });
        this.#relayedGrants.set(key, earlier);
      }
      return;
    }
    const requestId = text(seen.payload, "requestId");
    if (requestId === undefined) return;
    this.#grants.set(requestId, { at: seen.event.timestamp, index: seen.index, leaseId, source });
  }

  #ended(seen: Seen): void {
    const leaseId = text(seen.payload, "leaseId");
    if (!this.#counts(seen) || leaseId === undefined) return;
    const key = this.#key(seen.worker, leaseId);
    const earlier = this.#ends.get(key) ?? [];
    earlier.push({ at: seen.event.timestamp, index: seen.index });
    this.#ends.set(key, earlier);
  }

  #provisioned(seen: Seen): void {
    const deviceId = text(seen.payload, "deviceId");
    const platform = platformOf(objectOf(seen.payload.spec)?.platform);
    const duration = number(seen.payload, "duration");
    if (seen.worker !== undefined && deviceId !== undefined && platform !== undefined) {
      this.#devicePlatform.set(this.#key(seen.worker, deviceId), platform);
    }
    if (this.#counts(seen) && duration !== undefined) {
      this.#addDevice(seen, { kind: "provisioning", platform, value: duration });
    }
  }

  #ready(seen: Seen): void {
    const deviceId = text(seen.payload, "deviceId");
    const duration = number(seen.payload, "bootDuration");
    if (!this.#counts(seen) || duration === undefined) return;
    this.#addDevice(seen, {
      kind: "boot",
      platform: this.#platformOfDevice(seen.worker, deviceId),
      value: duration,
    });
  }

  #deviceEvent(seen: Seen): void {
    const incident = INCIDENT_OF[seen.event.event];
    const failure = isFailure(seen.event.event);
    if (!this.#counts(seen) || (incident === undefined && !failure)) return;
    const platform =
      platformOf(seen.payload.platform) ??
      this.#platformOfDevice(seen.worker, text(seen.payload, "deviceId"));
    if (incident !== undefined)
      this.#addDevice(seen, { kind: "incident", platform, value: incident });
    if (failure) this.#addDevice(seen, { kind: "failure", platform, value: seen.event.event });
  }

  #platformOfDevice(worker: string, deviceId: string | undefined): Platform | undefined {
    return deviceId === undefined
      ? undefined
      : this.#devicePlatform.get(this.#key(worker, deviceId));
  }

  #addDevice(seen: Seen, fact: Omit<DeviceFact, "worker">): void {
    this.#devices.push({ ...fact, worker: seen.worker });
    if (seen.worker !== undefined) this.#workers.add(seen.worker);
  }

  // ---- joining a request with what became of it -------------------------------------------

  /** One fact for each request the window saw made, joined with its outcome and its end. */
  #requests(): RequestFact[] {
    const facts: RequestFact[] = [];
    for (const [requestId, request] of this.#requested) {
      facts.push(this.#factFor(requestId, request));
    }
    return facts;
  }

  /**
   * The requests made before the window that the history does not report answered by its start.
   * One a gateway restart ended may carry an outcome from before the window, which settles it for
   * every time in it. A worker's probe never waits there (ADR 0021 §5).
   */
  #carriedOpen(): RequestFact[] {
    const facts: RequestFact[] = [];
    for (const request of this.#carriedRequests.values()) {
      if (request.probe || this.options.answeredBefore.has(request.requestId)) continue;
      facts.push(this.#factFor(request.requestId, request));
    }
    return facts;
  }

  #factFor(requestId: string, request: Request): RequestFact {
    const base = {
      platform: request.platform,
      requestedAt: request.at,
      requester: request.requester,
      ...(request.probe ? { probe: true as const } : {}),
    };
    return this.options.fleet
      ? this.#fleetFact(base, requestId, request)
      : this.#workerFact(base, requestId, this.options.self);
  }

  #workerFact(base: RequestFactBase, requestId: string, own: string): RequestFact {
    const rejection = this.#ownRejections.get(requestId);
    if (rejection !== undefined) {
      return { ...base, outcome: rejectedOf(rejection), worker: own };
    }
    const grant = this.#grants.get(requestId);
    if (grant === undefined) return { ...base, worker: own };
    const outcome: Granted = { at: grant.at, kind: "granted", source: grant.source };
    return this.#withHeld(
      { ...base, outcome, worker: own },
      this.#heldFor(own, grant.leaseId, grant),
    );
  }

  /**
   * A fleet request's outcome is the gateway's own `request.granted` or `lease.rejected` for its
   * request id; with neither, the gateway's next start ends it; else it is open (ADR 0021 §5).
   */
  #fleetFact(base: RequestFactBase, requestId: string, request: Request): RequestFact {
    const rejection = this.#ownRejections.get(requestId);
    if (rejection !== undefined) {
      if (rejection.worker !== undefined) this.#workers.add(rejection.worker);
      return { ...base, outcome: rejectedOf(rejection), worker: rejection.worker };
    }
    const handed = this.#handed.get(requestId);
    if (handed !== undefined) return this.#grantedFleetFact(base, handed);
    const restart = this.#restarts.find((candidate) => candidate.index > request.index);
    if (restart === undefined) return { ...base, worker: undefined };
    const outcome: Rejected = { at: restart.at, kind: "rejected", reason: "daemon-restarted" };
    return { ...base, outcome, worker: undefined };
  }

  /** The grant source and the held time are the worker's own facts, by the worker's clock. */
  #grantedFleetFact(
    base: RequestFactBase,
    handed: { readonly at: number; readonly worker: string; readonly workerLeaseId: string },
  ): RequestFact {
    this.#workers.add(handed.worker);
    const relayed = this.#relayedGrantFor(handed);
    const outcome: Granted = {
      at: handed.at,
      kind: "granted",
      source: relayed === undefined ? "unknown" : relayed.source,
    };
    const fact = { ...base, outcome, worker: handed.worker };
    return relayed === undefined
      ? fact
      : this.#withHeld(fact, this.#heldFor(handed.worker, handed.workerLeaseId, relayed));
  }

  /** Of the grants a worker relayed under one lease id, the one nearest in time to the handover. */
  #relayedGrantFor(handed: {
    readonly at: number;
    readonly worker: string;
    readonly workerLeaseId: string;
  }): RelayedGrant | undefined {
    const candidates = this.#relayedGrants.get(this.#key(handed.worker, handed.workerLeaseId));
    let nearest: RelayedGrant | undefined;
    for (const candidate of candidates ?? []) {
      if (
        nearest === undefined ||
        Math.abs(candidate.at - handed.at) < Math.abs(nearest.at - handed.at)
      ) {
        nearest = candidate;
      }
    }
    return nearest;
  }

  /** How long a lease was held, from its grant to the first end after it the window saw. */
  #heldFor(
    worker: string,
    leaseId: string,
    grant: { readonly at: number; readonly index: number },
  ): number | undefined {
    const end = this.#ends.get(this.#key(worker, leaseId))?.find((e) => e.index > grant.index);
    return end === undefined ? undefined : end.at - grant.at;
  }

  #withHeld(fact: RequestFact, heldMs: number | undefined): RequestFact {
    return heldMs === undefined ? fact : { ...fact, heldMs };
  }

  /** A gateway's or worker's own rejection of a request the window did not see made, when its
   * reason is one given before admission. */
  #refusedAtAdmission(): RequestFact[] {
    const facts: RequestFact[] = [];
    for (const [requestId, rejection] of this.#ownRejections) {
      if (this.#requested.has(requestId) || this.options.requestedBefore.has(requestId)) continue;
      if (!REFUSED_AT_ADMISSION.has(rejection.reason)) continue;
      facts.push({
        outcome: rejectedOf(rejection),
        platform: rejection.platform,
        requestedAt: undefined,
        requester: rejection.requester,
        worker: this.options.fleet ? undefined : this.options.self,
      });
    }
    return facts;
  }
}

const rejectedOf = (rejection: OwnRejection): Rejected => ({
  at: rejection.at,
  kind: "rejected",
  reason: rejection.reason,
});

function requestPlatform(payload: Payload): Platform | undefined {
  return platformOf(objectOf(payload.requestSpec)?.platform);
}

function capacityEntry(
  entry: unknown,
):
  | { readonly running: number; readonly reserved: number; readonly maxRunning: number }
  | undefined {
  const figures = objectOf(entry);
  if (figures === undefined) return undefined;
  const running = number(figures, "running");
  const reserved = number(figures, "reserved");
  const maxRunning = number(figures, "maxRunning");
  return running === undefined || reserved === undefined || maxRunning === undefined
    ? undefined
    : { maxRunning, reserved, running };
}

/** A `capacity.changed` as a step, or `undefined` for a payload that is not one. */
function capacityStep(payload: Payload, at: number, key: string): CapacityStep | undefined {
  const global = capacityEntry(payload.global);
  const ios = capacityEntry(payload.ios);
  const android = capacityEntry(payload.android);
  if (global === undefined || ios === undefined || android === undefined) return undefined;
  const budget = objectOf(payload.ramBudget);
  const used = budget === undefined ? undefined : number(budget, "usedBytes");
  const limit = budget === undefined ? undefined : number(budget, "limitBytes");
  const ram = used === undefined || limit === undefined ? undefined : { limit, used };
  const valueOf = (entry: NonNullable<ReturnType<typeof capacityEntry>>): CapacityValue => ({
    max: entry.maxRunning,
    ram,
    used: entry.running + entry.reserved,
  });
  return {
    at,
    key,
    value: { ...valueOf(global), platforms: { android: valueOf(android), ios: valueOf(ios) } },
  };
}
