import { type AdmissionDecision, type AdmissionOptions, askAdmission } from "./admission.js";
import {
  admissionDeniedError,
  admissionFailedError,
  leaseEndedError,
  type Platform,
} from "../contract/index.js";
import {
  type DeviceRequest,
  type LeaseRequestFailure,
  type LeaseRequestLimits,
  type MaxPerRequester,
  newLeaseRequestId,
  SerializedDecision,
} from "../core/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import {
  InMemoryLeaseRequestStore,
  LeaseRequestBook,
  requesterLimitDecision,
} from "../leasing/index.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import type { EndedLeaseIds } from "./ended-lease-ids.js";
import type { FleetDispatch } from "./fleet-dispatch.js";
import type { FleetFacts } from "./fleet-facts.js";
import { leaseIdTaken } from "./fleet-grant.js";
import type { FleetViews, WorkerDirectory } from "./fleet-ports.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import {
  RequestCancelledError,
  type FleetLeaseGrant,
  type FleetQueue,
  type LeaseRequestOptions,
} from "./queue.js";

/**
 * why: ADR 0074 §1: `admissionRequest` is the `lease.request` input as the caller sent it, which the
 * admission command reads; the gateway dispatcher fills `ttlMs` and drops `allowDownload` after that.
 */
export type FleetRequestOptions = LeaseRequestOptions & {
  readonly admissionRequest?: Readonly<Record<string, unknown>>;
  /** why: ADR 0074 §3: the caller's `metadata` goes to the admission command only, never into an event, a record or a worker call. */
  readonly admissionMetadata?: Readonly<Record<string, string>>;
};

/** why: a request whose admission command is running: `lease.cancel` and `dispose` end it by aborting `controller`. */
interface AskingRequest {
  readonly requesterId: string;
  readonly platform: Platform;
  readonly controller: AbortController;
  end?: "cancelled" | "stopping";
}

export interface FleetAdmissionOptions {
  readonly admission?: AdmissionOptions;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly describeFailure: (error: unknown) => LeaseRequestFailure;
  readonly leaseRequestLimits: LeaseRequestLimits;
  readonly maxPerRequester?: MaxPerRequester;
  readonly leaseIndex: FleetLeaseIndex;
  readonly views: FleetViews;
  readonly endedLeaseIds: EndedLeaseIds;
  readonly directory: WorkerDirectory;
  readonly logger: Logger;
  readonly queue: FleetQueue;
  readonly facts: FleetFacts;
  readonly dispatch: Pick<FleetDispatch, "admit" | "noteCreated">;
}

export class FleetAdmission {
  readonly #decisions = new SerializedDecision();
  readonly #asking = new Set<AskingRequest>();
  readonly requests: LeaseRequestBook<FleetLeaseGrant>;

  constructor(private readonly options: FleetAdmissionOptions) {
    this.requests = new LeaseRequestBook({
      decisions: this.#decisions,
      describeFailure: options.describeFailure,
      store: new InMemoryLeaseRequestStore({
        clock: options.clock,
        idGenerator: options.idGenerator,
        limits: options.leaseRequestLimits,
      }),
    });
  }

  /**
   * why: Admits a request and returns the eventual grant. The one-lease check and the enqueue commit
   * together, inside `SerializedDecision.run`, so two concurrent requests for the same
   * `requesterId` can never both be admitted (see the module doc's "two different fields").
   * Everything past admission -- reaching a worker at all -- is I/O and stays outside it.
   */
  async request(
    deviceRequest: DeviceRequest,
    options: FleetRequestOptions,
  ): Promise<FleetLeaseGrant> {
    // why: ADR 0074 §1: with a command, the checks run under the lock, then the command outside it, then the checks again with the answer under the lock; no await without a command, so a `lease.cancel` sent right after the request finds it in the same tick (#1492). The request is listed as asking before the first await, so a cancel or a stop in that window ends it too.
    const { admission } = this.options;
    let decision: AdmissionDecision | undefined;
    if (admission !== undefined) {
      const asking: AskingRequest = {
        controller: new AbortController(),
        platform: deviceRequest.platform,
        requesterId: options.requesterId,
      };
      this.#asking.add(asking);
      try {
        const early = await this.#decisions.run(async () =>
          this.#checkAdmission(deviceRequest, options),
        );
        if ("replay" in early) return early.replay;
        // why: the caller is answered at once; the runner kills the command on its own time (it kills with SIGKILL).
        if (asking.end === undefined) {
          decision = await Promise.race([
            this.#askAdmission(admission, deviceRequest, options, asking.controller),
            new Promise<undefined>((resolve) =>
              asking.controller.signal.addEventListener("abort", () => resolve(undefined), {
                once: true,
              }),
            ),
          ]);
        }
      } finally {
        this.#asking.delete(asking);
      }
      if (asking.end !== undefined)
        this.#refuseEndedWhileAsking(asking.end, deviceRequest, options);
    }
    const admitted = await this.#decisions.run(async () => {
      const checked = this.#checkAdmission(deviceRequest, options);
      if ("replay" in checked) return checked;
      const { requestId } = checked;
      if (decision !== undefined && decision.kind !== "priority") {
        this.#refuseByAdmission(decision, deviceRequest, options, requestId);
      }
      const { id, started } = await this.requests.admit(
        deviceRequest,
        options,
        (id, onProgress) => {
          const waiter = this.options.queue.create(
            deviceRequest,
            { ...options, onProgress },
            id,
            decision?.kind === "priority" ? decision.priority : 0,
          );
          return { promise: this.#afterViewRead(waiter.promise), waiter };
        },
        requestId,
      );
      const created = started.waiter;
      this.options.dispatch.noteCreated(created);
      this.options.facts.emit("lease.requested", {
        requestId: id,
        requestSpec: deviceRequest,
        requester: options.requesterId,
        waitPolicy: options.noWait === true ? "no-wait" : "wait",
      });
      return { promise: started.promise, waiter: created };
    });
    if ("replay" in admitted) return admitted.replay;
    this.options.dispatch.admit(admitted.waiter);
    return admitted.promise;
  }

  #endAsking(asking: AskingRequest, end: "cancelled" | "stopping"): void {
    asking.end = end;
    asking.controller.abort();
  }

  /** why: replay, the requester limit, a taken id and an ended id, in this order; a refusal is thrown, a replay returned. */
  #checkAdmission(
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
  ): { readonly replay: Promise<FleetLeaseGrant> } | { readonly requestId: string } {
    const replay = this.requests.replay(deviceRequest, options);
    if (replay !== undefined) return { replay };
    const requestId = newLeaseRequestId(this.options.idGenerator);
    this.#refuseIfAlreadyLeased(deviceRequest, options.requesterId, requestId);
    this.#refuseIfLeaseIdTaken(deviceRequest, options, requestId);
    this.#refuseIfLeaseIdEnded(deviceRequest, options, requestId);
    return { requestId };
  }

  /** why: ADR 0074 §1: the operator's command answers outside the decision lock, since it may take seconds. */
  #askAdmission(
    admission: AdmissionOptions,
    deviceRequest: DeviceRequest,
    options: FleetRequestOptions,
    controller: AbortController,
  ): Promise<AdmissionDecision> {
    return askAdmission(
      admission,
      {
        metadata: options.admissionMetadata ?? {},
        platform: deviceRequest.platform,
        principal: options.ownerId,
        request: options.admissionRequest ?? deviceRequest,
        requesterId: options.requesterId,
      },
      this.options.logger,
      controller.signal,
    );
  }

  /** why: the caller cancelled, or the gateway stopped, while the command ran: nothing was stored, so there is nothing to undo. */
  #refuseEndedWhileAsking(
    end: "cancelled" | "stopping",
    deviceRequest: DeviceRequest,
    options: FleetRequestOptions,
  ): never {
    if (end === "stopping") throw new DispatchError("DAEMON_STOPPING", "Gateway is stopping");
    const requestId = newLeaseRequestId(this.options.idGenerator);
    this.options.facts.emit("lease.rejected", {
      requestId,
      requester: options.requesterId,
      requestSpec: deviceRequest,
      reason: "cancelled",
    });
    throw new RequestCancelledError(requestId);
  }

  #refuseByAdmission(
    decision: Exclude<AdmissionDecision, { readonly kind: "priority" }>,
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): never {
    this.options.facts.emit("lease.rejected", {
      requestId,
      requester: options.requesterId,
      requestSpec: deviceRequest,
      reason: decision.kind === "deny" ? "admission-denied" : "admission-failed",
    });
    const refusal =
      decision.kind === "deny"
        ? admissionDeniedError(decision.reason)
        : admissionFailedError(decision.cause);
    throw new DispatchError(refusal.code, refusal.message, refusal.details);
  }

  /**
   * why: the request book stores `granted` and wakes its watchers when this promise settles, and the
   * worker's own `lease.granted` push starts its view read later; so the grant waits for one read of the
   * granting worker's view here, and a `lease.list` right after any answer lists the lease (#1370). A
   * failed read is the next tick's.
   */
  async #afterViewRead(grant: Promise<FleetLeaseGrant>): Promise<FleetLeaseGrant> {
    const granted = await grant;
    const entry = this.options.leaseIndex.resolve(granted.lease.id);
    if (entry !== undefined) {
      await this.options.directory
        .target(entry.workerId)
        ?.refresh()
        .catch((error: unknown) => {
          this.options.logger.debug("Failed to refresh a worker's view after granting it a lease", {
            error: String(error),
            workerId: entry.workerId,
          });
        });
    }
    return granted;
  }

  #refuseIfAlreadyLeased(
    deviceRequest: DeviceRequest,
    requesterId: string,
    requestId: string,
  ): void {
    const refusal = requesterLimitDecision({
      held: this.options.leaseIndex
        .held(requesterId)
        .filter((lease) => !this.#isPastDeadlineOnDisconnectedWorker(lease.id)),
      maxPerRequester: this.options.maxPerRequester,
      platform: deviceRequest.platform,
      probe: false,
      requesterId,
      waiting: this.options.queue.pendingPlatforms(requesterId),
    });
    if (refusal === undefined) return;
    this.options.facts.emit("lease.rejected", {
      requestId,
      requester: requesterId,
      requestSpec: deviceRequest,
      reason: "already-leased",
    });
    throw refusal;
  }

  /**
   * why: a lease past its last reported deadline on a disconnected worker cannot have been renewed
   * through this gateway, so it must not lock its requester out of the fleet. The entry stays in
   * the index: it is still routed to its worker (ADR 0005 §28).
   */
  #isPastDeadlineOnDisconnectedWorker(gatewayLeaseId: string): boolean {
    const entry = this.options.leaseIndex.resolve(gatewayLeaseId);
    if (entry === undefined) return false;
    const view = this.options.views.view(entry.workerId);
    if (view === undefined || view.connection !== "disconnected") return false;
    const reported = view.leases?.find((lease) => lease.id === entry.workerLeaseId);
    return reported !== undefined && reported.ttlDeadline <= this.options.clock.now();
  }

  /**
   * why: ADR 0020: the one clash check on a gateway, after the one-lease check and in the same
   * admission section. A caller-chosen id is held by one of this gateway's leases and by one of
   * its own requests still open; leases a local client holds on a worker are not checked (a
   * worker refuses its own, and the requester's uniqueness guarantee makes a clash unlikely).
   */
  #refuseIfLeaseIdTaken(
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    if (
      this.options.leaseIndex.resolve(leaseId) === undefined &&
      !this.requests.holdsLeaseId(leaseId)
    ) {
      return;
    }
    this.options.facts.emit("lease.rejected", {
      requestId,
      requester: options.requesterId,
      requestSpec: deviceRequest,
      reason: "lease-id-taken",
    });
    throw leaseIdTaken(leaseId);
  }

  /** why: ADR 0074 §4: after the taken-id check, a chosen id whose lease this gateway learned ended is refused without a dispatch; a worker answers for ends the gateway missed. */
  #refuseIfLeaseIdEnded(
    deviceRequest: DeviceRequest,
    options: LeaseRequestOptions,
    requestId: string,
  ): void {
    const { leaseId } = options;
    if (leaseId === undefined) return;
    const endedAt = this.options.endedLeaseIds.endedAt(leaseId);
    if (endedAt === undefined) return;
    this.options.facts.emit("lease.rejected", {
      requestId,
      requester: options.requesterId,
      requestSpec: deviceRequest,
      reason: "lease-ended",
    });
    const ended = leaseEndedError(leaseId, endedAt);
    throw new DispatchError(ended.code, ended.message, ended.details);
  }

  /**
   * why: a `new` waiter is admitted but not yet walked: no worker was asked, so it is as safe to reject as
   * a `queued` one (#1492). Only `processing` means a worker already has the request.
   */
  async cancelPending(
    requesterId: string,
    platform?: Platform,
  ): Promise<"cancelled" | "not-found" | "not-cancellable"> {
    for (const asking of this.#asking) {
      if (
        asking.requesterId === requesterId &&
        (platform === undefined || asking.platform === platform)
      ) {
        this.#endAsking(asking, "cancelled");
        return "cancelled";
      }
    }
    return this.#decisions.run(async () => {
      const waiter = this.options.queue.findPendingWaiter(requesterId, platform);
      if (waiter === undefined) return "not-found";
      if (waiter.state === "processing") return "not-cancellable";
      if (this.options.queue.reject(waiter, new RequestCancelledError(waiter.id))) {
        this.options.facts.rejected(waiter, "cancelled");
      }
      return "cancelled";
    });
  }

  stopAsking(): void {
    for (const asking of this.#asking) this.#endAsking(asking, "stopping");
  }
}
