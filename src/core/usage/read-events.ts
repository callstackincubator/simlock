import type { EventEnvelope } from "../../bus/index.js";
import type { UsageFigures } from "../../contract/index.js";
import type { Step } from "./timeline.js";

/**
 * Reads a window's events into the facts the figures count (ADR 0016 §2, §6): one fact for each
 * request, one for each device event that counts, and the capacity and queue steps. Nothing here
 * adds a number up.
 */

export type Platform = "ios" | "android";

export interface RequestFact {
  readonly requester: string;
  readonly platform: Platform | undefined;
  /** The worker that served it: a worker's own, or the one a gateway dispatched it to. */
  readonly worker: string | undefined;
  /** `undefined` for a rejection refused before the request was stored, which is no request. */
  readonly requestedAt: number | undefined;
  readonly outcome?: Granted | Rejected;
  /** When the lease ended, if the window saw it. */
  readonly endedAt?: number;
}

type RequestFactBase = Pick<RequestFact, "platform" | "requestedAt" | "requester">;

interface Granted {
  readonly kind: "granted";
  readonly at: number;
  readonly source: string;
}

interface Rejected {
  readonly kind: "rejected";
  readonly at: number;
  readonly reason: string;
}

export interface DeviceFact {
  readonly kind: "provisioning" | "boot" | "incident" | "error";
  readonly worker: string | undefined;
  readonly platform: Platform | undefined;
  /** The duration for the first two, the incident or error name for the others. */
  readonly value: number | string;
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
  readonly devices: readonly DeviceFact[];
  readonly capacity: readonly CapacityStep[];
  readonly queue: readonly Step<number>[];
  readonly workers: ReadonlySet<string>;
}

export interface ReadOptions {
  readonly fleet: boolean;
  /** The `requestId` of every request made before the window. */
  readonly requestedBefore: ReadonlySet<string>;
  /** The id a worker's own events are attributed to. */
  readonly self: string;
  /** What a gateway puts in front of a requester it forwards. */
  readonly requesterPrefix: string;
}

export interface UsageWindow {
  readonly from: number;
  readonly to: number;
}

type Payload = Readonly<Record<string, unknown>>;
type Incident = keyof UsageFigures["incidents"];

/** A rejection with no `lease.requested` anywhere in the history read was refused before the
 * request was stored; only these two reasons are ever given before admission. One whose request
 * is in the history follows that request: counted with it, or in no count when it was made before
 * the window. */
const REFUSED_AT_ADMISSION = new Set(["already-leased", "killed"]);
/** The device events that count as an incident, by what the figure calls them. */
const INCIDENT_OF: Readonly<Record<string, Incident>> = {
  "device.quarantine-abandoned": "lost",
  "device.quarantine-recovered": "quarantineRecovered",
  "device.quarantine-stranded": "lost",
  "device.quarantined": "quarantined",
  "device.recovered": "crashRecovered",
  "device.recovery-failed": "lost",
};
/** Failures that carry no reason of their own among the rejections, counted by their event name. */
const ERROR_EVENTS = new Set(["device.purge-failed", "component.install-failed"]);

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

/** A relayed grant or rejection, kept for the request that will claim it. */
type RelayedAnswer =
  | { readonly kind: "granted"; readonly source: string; readonly leaseId: string }
  | { readonly kind: "rejected"; readonly reason: string };
type Relayed = { readonly index: number; readonly at: number } & RelayedAnswer;

interface Dispatch {
  readonly index: number;
  readonly requestId: string;
  readonly requester: string;
  readonly worker: string;
}

interface Request {
  readonly index: number;
  readonly at: number;
  readonly requester: string;
  readonly platform: Platform | undefined;
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
  readonly #capacity: CapacityStep[] = [];
  readonly #queue: Step<number>[] = [];
  readonly #workers = new Set<string>();
  readonly #devicePlatform = new Map<string, Platform>();
  readonly #requested = new Map<string, Request>();
  readonly #ownRejections = new Map<
    string,
    Omit<Rejected, "kind"> & {
      readonly requester: string;
      readonly platform: Platform | undefined;
    }
  >();
  readonly #grants = new Map<string, Granted & { readonly leaseId: string }>();
  readonly #ends = new Map<string, number>();
  readonly #dispatches = new Map<string, Dispatch>();
  readonly #boundaries = new Map<string, number[]>();
  readonly #relayed = new Map<string, Relayed[]>();
  readonly #handlers: Record<string, (seen: Seen) => void> = {
    "capacity.changed": (seen) => this.#capacityChanged(seen),
    "device.provisioned": (seen) => this.#provisioned(seen),
    "device.ready": (seen) => this.#ready(seen),
    "lease.expired": (seen) => this.#ended(seen),
    "lease.granted": (seen) => this.#granted(seen),
    "lease.rejected": (seen) => this.#rejected(seen),
    "lease.released": (seen) => this.#ended(seen),
    "lease.requested": (seen) => this.#leaseRequested(seen),
    "queue.changed": (seen) => this.#queueChanged(seen),
    "request.dispatched": (seen) => this.#dispatched(seen),
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

  #boundary(requester: string | undefined, index: number): void {
    if (requester === undefined) return;
    this.#boundaries.set(requester, [...this.#boundariesOf(requester), index]);
  }

  #boundariesOf(requester: string): readonly number[] {
    return this.#boundaries.get(requester) ?? [];
  }

  #leaseRequested(seen: Seen): void {
    if (!seen.own) return;
    const requestId = text(seen.payload, "requestId");
    const requester = text(seen.payload, "requester");
    this.#boundary(requester, seen.index);
    if (!seen.within || requestId === undefined || requester === undefined) return;
    this.#requested.set(requestId, {
      at: seen.event.timestamp,
      index: seen.index,
      platform: requestPlatform(seen.payload),
      requester,
    });
  }

  #dispatched(seen: Seen): void {
    const requestId = text(seen.payload, "requestId");
    const requester = text(seen.payload, "requesterId");
    const worker = text(seen.payload, "workerId");
    this.#boundary(requester, seen.index);
    if (!this.options.fleet || !seen.within) return;
    if (requestId === undefined || requester === undefined || worker === undefined) return;
    this.#dispatches.set(requestId, { index: seen.index, requestId, requester, worker });
  }

  #relay(seen: Seen, relayed: RelayedAnswer): void {
    const requester = text(seen.payload, "requester");
    if (requester === undefined || seen.worker === undefined) return;
    const key = this.#key(seen.worker, requester);
    const entry = { ...relayed, at: seen.event.timestamp, index: seen.index } as Relayed;
    this.#relayed.set(key, [...(this.#relayed.get(key) ?? []), entry]);
  }

  #rejected(seen: Seen): void {
    const requestId = text(seen.payload, "requestId");
    const reason = text(seen.payload, "reason");
    if (!seen.within || requestId === undefined || reason === undefined) return;
    const requester = text(seen.payload, "requester");
    if (seen.own) {
      if (requester === undefined) return;
      this.#ownRejections.set(requestId, {
        at: seen.event.timestamp,
        platform: requestPlatform(seen.payload),
        reason,
        requester,
      });
    } else {
      this.#relay(seen, { kind: "rejected", reason });
    }
  }

  #granted(seen: Seen): void {
    if (!seen.within) return;
    if (this.options.fleet) {
      this.#relay(seen, {
        kind: "granted",
        leaseId: text(seen.payload, "leaseId") ?? "",
        source: text(seen.payload, "source") ?? "",
      });
      return;
    }
    const requestId = text(seen.payload, "requestId");
    const leaseId = text(seen.payload, "leaseId");
    if (requestId === undefined || leaseId === undefined) return;
    this.#grants.set(requestId, {
      at: seen.event.timestamp,
      kind: "granted",
      leaseId,
      source: text(seen.payload, "source") ?? "",
    });
  }

  #ended(seen: Seen): void {
    const leaseId = text(seen.payload, "leaseId");
    if (!this.#counts(seen) || leaseId === undefined) return;
    this.#ends.set(this.#key(seen.worker, leaseId), seen.event.timestamp);
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
    if (!this.#counts(seen) || (incident === undefined && !ERROR_EVENTS.has(seen.event.event)))
      return;
    const platform =
      platformOf(seen.payload.platform) ??
      this.#platformOfDevice(seen.worker, text(seen.payload, "deviceId"));
    this.#addDevice(seen, {
      kind: incident === undefined ? "error" : "incident",
      platform,
      value: incident ?? seen.event.event,
    });
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

  #factFor(requestId: string, request: Request): RequestFact {
    const rejection = this.#ownRejections.get(requestId);
    const own = this.options.fleet ? undefined : this.options.self;
    const base = {
      platform: request.platform,
      requestedAt: request.at,
      requester: request.requester,
    };
    if (rejection !== undefined) {
      const outcome: Rejected = { at: rejection.at, kind: "rejected", reason: rejection.reason };
      return { ...base, outcome, worker: own };
    }
    return this.options.fleet
      ? this.#fleetFact(base, requestId, request)
      : this.#workerFact(base, requestId, this.options.self);
  }

  #workerFact(base: RequestFactBase, requestId: string, own: string): RequestFact {
    const grant = this.#grants.get(requestId);
    return grant === undefined
      ? { ...base, worker: own }
      : this.#withEnd({ ...base, outcome: grant, worker: own }, grant.leaseId, own);
  }

  /** A fleet request's outcome is the worker's, found through its dispatch (ADR 0016 §6). */
  #fleetFact(base: RequestFactBase, requestId: string, request: Request): RequestFact {
    const dispatch = this.#dispatches.get(requestId);
    if (dispatch === undefined) return { ...base, worker: undefined };
    this.#workers.add(dispatch.worker);
    const worker = dispatch.worker;
    const relayed = this.#fleetOutcome(dispatch, request.index);
    if (relayed === undefined) return { ...base, worker };
    if (relayed.kind === "rejected") {
      const outcome: Rejected = { at: relayed.at, kind: "rejected", reason: relayed.reason };
      return { ...base, outcome, worker };
    }
    const outcome: Granted = { at: relayed.at, kind: "granted", source: relayed.source };
    return this.#withEnd({ ...base, outcome, worker }, relayed.leaseId, worker);
  }

  #withEnd(fact: RequestFact, leaseId: string, worker: string): RequestFact {
    const endedAt = this.#ends.get(this.#key(worker, leaseId));
    return endedAt === undefined ? fact : { ...fact, endedAt };
  }

  /**
   * The first relayed grant or rejection from the worker a request was dispatched to, for its
   * namespaced requester, that falls before the requester's next request (ADR 0016 §6). A rejection
   * must come at or after the dispatch. A grant may come before it: a warm device is granted
   * before the answer that announces the dispatch reaches the gateway, so a grant counts from the
   * request.
   */
  #fleetOutcome(dispatch: Dispatch, requestIndex: number): Relayed | undefined {
    const next = this.#boundariesOf(dispatch.requester).find((index) => index > dispatch.index);
    const key = this.#key(dispatch.worker, `${this.options.requesterPrefix}${dispatch.requester}`);
    return (this.#relayed.get(key) ?? []).find(
      (candidate) =>
        candidate.index >= (candidate.kind === "granted" ? requestIndex : dispatch.index) &&
        (next === undefined || candidate.index < next),
    );
  }

  /** A gateway's or worker's own rejection of a request the window did not see made, when its
   * reason is one given before admission. */
  #refusedAtAdmission(): RequestFact[] {
    const facts: RequestFact[] = [];
    for (const [requestId, rejection] of this.#ownRejections) {
      if (this.#requested.has(requestId) || this.options.requestedBefore.has(requestId)) continue;
      if (!REFUSED_AT_ADMISSION.has(rejection.reason)) continue;
      facts.push({
        outcome: { at: rejection.at, kind: "rejected", reason: rejection.reason },
        platform: rejection.platform,
        requestedAt: undefined,
        requester: rejection.requester,
        worker: this.options.fleet ? undefined : this.options.self,
      });
    }
    return facts;
  }
}

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
