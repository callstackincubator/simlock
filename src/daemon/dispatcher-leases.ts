import { requestedDevice } from "../contract/index.js";
import {
  effectiveAllowDownload,
  RuntimeMissingError,
  UnknownLeaseError,
  type DeviceRequest,
} from "../core/index.js";
import { capacityReasonOf, NoCapacityError } from "../leasing/index.js";
import { DispatchError, principalAsRequester } from "./dispatch.js";
import { requireCapabilities } from "./dispatcher-capabilities.js";
import { leasesFor } from "./dispatcher-device-views.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";
import { leaseRequestRefusal } from "./lease-request-refusal.js";
import { UnadmittedRequests } from "./unadmitted-requests.js";

export class LeaseHandlers {
  readonly #unadmitted = new UnadmittedRequests();

  constructor(private readonly options: DispatcherOptions) {}

  readonly leaseRequest: Handler<"lease.request"> = async (input, session) => {
    const request: DeviceRequest = requestedDevice(input);
    this.#requireTtlWithinCap(input.ttlMs);
    const requesterId = input.requesterId ?? principalAsRequester(session.principal);
    // fallow-ignore-next-line complexity -- lease payload assembly and the download-policy rewrite are one transaction, moved verbatim from DaemonServer's former #requestLease.
    return this.#unadmitted.track(requesterId, async (admittedHook) => {
      const requestedAllowDownload = input.allowDownload ?? false;
      const downloadsPolicy = this.options.config.downloads.policy;
      // why: `owner` is read only from the gateway's uplink, never from role alone: HTTP's `operator` token
      // maps to `admin`, so a role check would let any operator name someone else's owner. Refused, not ignored.
      if (input.owner !== undefined && session.isGatewayUplink !== true) {
        throw new DispatchError(
          "FORBIDDEN",
          "Only the gateway's own uplink session may set lease.request's `owner` field",
        );
      }
      // why: Uplink only, refused before anything is stored: a probe is never queued on a worker, so it must say `noWait`.
      if (input.fleetRequestId !== undefined) {
        if (session.isGatewayUplink !== true) {
          throw new DispatchError(
            "FORBIDDEN",
            "Only the gateway's own uplink session may set lease.request's `fleetRequestId` field",
          );
        }
        if (input.noWait !== true) {
          throw new DispatchError(
            "BAD_REQUEST",
            "lease.request's `fleetRequestId` is sent only with `noWait: true`",
          );
        }
      }
      await requireCapabilities(this.options, input.requires);
      const ownerId = input.owner ?? session.principal;
      try {
        const grant = await this.options.leases.request(request, {
          allowDownload: effectiveAllowDownload(downloadsPolicy, requestedAllowDownload),
          noWait: input.noWait ?? false,
          ownerId,
          requesterId,
          ...(session.onProgress === undefined ? {} : { onProgress: session.onProgress }),
          onAdmitted: admittedHook(session.onRequestAdmitted),
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.fleetRequestId === undefined ? {} : { fleetRequestId: input.fleetRequestId }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
        const { device } = grant;
        return {
          ...grant,
          device: device.physical ? { ...device, class: device.spec.class } : device,
        };
      } catch (error: unknown) {
        const refusal = leaseRequestRefusal(error);
        if (refusal !== undefined) throw refusal;
        if (error instanceof NoCapacityError) {
          const capacityReason = capacityReasonOf(error.reason);
          if (capacityReason !== undefined) {
            throw new DispatchError("NO_CAPACITY", error.message, { capacityReason });
          }
        }
        // why: The lease path sees only the clamped-to-false permission, so this is the one place that can
        // tell the caller that config, not missing consent, blocked the download.
        if (
          downloadsPolicy === "never" &&
          error instanceof RuntimeMissingError &&
          error.downloadable
        ) {
          error.message = `${error.message} (downloads are disabled by configuration: downloads.policy is "never")`;
        }
        throw error;
      }
    });
  };

  readonly leaseCancel: Handler<"lease.cancel"> = async (input, session) => {
    const requesterId = input.requesterId ?? session.principal;
    await this.#unadmitted.settled(requesterId);
    const result = await this.options.queue.cancelPending(requesterId, input.platform);
    return { result };
  };

  readonly leaseRenew: Handler<"lease.renew"> = async (input) => {
    this.#requireTtlWithinCap(input.ttlMs);
    return this.options.leases.renew(input.leaseId, input.ttlMs);
  };

  #requireTtlWithinCap(ttlMs: number | undefined): void {
    const maxTtlMs = this.options.config.lease.maxTtlMs;
    if (ttlMs !== undefined && ttlMs > maxTtlMs) {
      throw new DispatchError(
        "BAD_REQUEST",
        `ttlMs ${String(ttlMs)} exceeds lease.maxTtlMs (${String(maxTtlMs)})`,
      );
    }
  }

  readonly leaseRelease: Handler<"lease.release"> = async (input) => {
    await this.options.leases.release(input.leaseId, "explicit");
    return { leaseId: input.leaseId };
  };

  readonly leaseReleaseAll: Handler<"lease.release-all"> = async () => {
    const leaseIds = await this.options.leases.releaseAll("killed");
    return { leaseIds: [...leaseIds] };
  };

  readonly leaseReleaseRun: Handler<"lease.release-run"> = async (input, session) => {
    const released = await this.options.leases.releaseRun(
      input.runId,
      session.role === "admin" ? undefined : session.principal,
    );
    return { leaseIds: [...released.leaseIds], requestIds: [...released.requestIds] };
  };

  readonly leaseGet: Handler<"lease.get"> = (input, session) => {
    const lease = this.options.registry.snapshot.leases.find(
      (candidate) => candidate.id === input.leaseId,
    );
    if (lease === undefined || (session.role !== "admin" && lease.ownerId !== session.principal)) {
      throw new UnknownLeaseError(input.leaseId);
    }
    return { lease };
  };

  readonly leaseList: Handler<"lease.list"> = (_input, session) => ({
    leases: leasesFor(this.options, session),
  });
}
