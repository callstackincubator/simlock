import { capacityReasonSchema } from "../contract/index.js";
import type { DispatchError } from "../daemon/dispatch.js";
import type { FleetViews } from "./fleet-ports.js";
import type { FleetWaiter } from "./queue.js";
import type { RoutableRequest, RoutingPolicy, WorkerExplanation } from "./routing.js";
import { type CapacityReason, viewLoadKey, type WorkerReason } from "./routing/index.js";
import type { WorkerView } from "./worker-registry.js";

export type WorkerEntry = WorkerReason & { readonly workerId: string };

export interface Refusal {
  readonly key: string;
  readonly capacityReason?: CapacityReason;
  readonly provisionFailure?: DispatchError;
}

const CANNOT_SERVE_REASONS: Readonly<Record<string, WorkerReason["reason"]>> = {
  CAPABILITY_MISSING: "capability-missing",
  NO_DRIVER: "no-driver",
  RUNTIME_MISSING: "runtime-missing",
  UNKNOWN_MODEL: "unknown-model",
  UNKNOWN_BASELINE: "no-baseline",
  BASELINE_MISMATCH: "baseline-mismatch",
  BASELINE_STALE: "baseline-stale",
};

export interface FleetRefusalsOptions {
  readonly routing: Pick<RoutingPolicy, "explain">;
  readonly views: Pick<FleetViews, "views">;
}

export class FleetRefusals {
  readonly #refusals = new WeakMap<FleetWaiter, Map<string, Refusal>>();
  readonly #cannotServe = new WeakMap<FleetWaiter, Map<string, DispatchError>>();

  constructor(private readonly options: FleetRefusalsOptions) {}

  cannotServe(waiter: FleetWaiter): ReadonlyMap<string, DispatchError> | undefined {
    return this.#cannotServe.get(waiter);
  }

  refusals(waiter: FleetWaiter): ReadonlyMap<string, Refusal> | undefined {
    return this.#refusals.get(waiter);
  }

  // why: the first failing check wins, in the order the spec lists: a filter reason, an unreachable target, a cannot-serve memo, a refusal at the current view, a claim this pass, a rank zero reason, else not-chosen.
  reasonsFor(
    waiter: FleetWaiter,
    request: RoutableRequest,
    views: readonly WorkerView[],
    options: {
      readonly claimed?: (workerId: string) => boolean;
      readonly unreachable?: string;
    } = {},
  ): readonly WorkerEntry[] {
    const explained = new Map(
      this.options.routing.explain(request, views).map((entry) => [entry.workerId, entry]),
    );
    return views.map((view): WorkerEntry => ({
      ...this.#reasonFor(waiter, view, explained.get(view.id), options),
      workerId: view.id,
    }));
  }

  #reasonFor(
    waiter: FleetWaiter,
    view: WorkerView,
    entry: WorkerExplanation | undefined,
    options: { readonly claimed?: (workerId: string) => boolean; readonly unreachable?: string },
  ): WorkerReason {
    if (entry?.filter !== undefined) return entry.filter;
    if (options.unreachable === view.id) return { reason: "disconnected" };
    const claimed = options.claimed?.(view.id) === true;
    return (
      this.#cannotServeReason(waiter, view.id) ??
      this.#refusedReason(waiter, view, entry?.zero) ??
      passedOver(claimed, entry?.zero)
    );
  }

  #cannotServeReason(waiter: FleetWaiter, workerId: string): WorkerReason | undefined {
    const code = this.#cannotServe.get(waiter)?.get(workerId)?.code;
    const reason = code === undefined ? undefined : CANNOT_SERVE_REASONS[code];
    return reason === undefined ? undefined : { reason };
  }

  #refusedReason(
    waiter: FleetWaiter,
    view: WorkerView,
    zero: WorkerReason | undefined,
  ): WorkerReason | undefined {
    if (!this.refused(waiter, view)) return undefined;
    const refusal = this.#refusals.get(waiter)?.get(view.id);
    // why: a failed provision is no capacity refusal; the worker lists as one that passed every check.
    if (refusal?.provisionFailure !== undefined) return undefined;
    const capacityReason = refusal?.capacityReason ?? zero?.capacityReason;
    return capacityReason === undefined ? { reason: "full" } : { capacityReason, reason: "full" };
  }

  rememberCannotServe(waiter: FleetWaiter, workerId: string, refusal: DispatchError): void {
    const refusals = this.#cannotServe.get(waiter) ?? new Map<string, DispatchError>();
    refusals.set(workerId, refusal);
    this.#cannotServe.set(waiter, refusals);
  }

  rememberRefusal(
    waiter: FleetWaiter,
    workerId: string,
    detail: {
      readonly capacityReason?: CapacityReason | undefined;
      readonly provisionFailure?: DispatchError;
    } = {},
  ): void {
    const view = this.options.views.views().find((worker) => worker.id === workerId);
    if (view === undefined) return;
    const refusals = this.#refusals.get(waiter) ?? new Map<string, Refusal>();
    // why: delete first so the map's order is the order the workers answered in; the last failure ends the request.
    refusals.delete(workerId);
    refusals.set(workerId, {
      key: viewLoadKey(view),
      ...(detail.capacityReason === undefined ? {} : { capacityReason: detail.capacityReason }),
      ...(detail.provisionFailure === undefined
        ? {}
        : { provisionFailure: detail.provisionFailure }),
    });
    this.#refusals.set(waiter, refusals);
  }

  refused(waiter: FleetWaiter, worker: WorkerView): boolean {
    const refusals = this.#refusals.get(waiter);
    const key = refusals?.get(worker.id)?.key;
    if (key === undefined) return false;
    if (key === viewLoadKey(worker)) return true;
    // why: a device unplugged and plugged back in returns the view to the key it was refused at; the refusal must end at the first change.
    refusals?.delete(worker.id);
    return false;
  }
}

// why: a relayed error's details are a claim; only a value of the contract's enum is kept.
export function refusedCapacityReason(details: unknown): Refusal["capacityReason"] {
  const parsed = capacityReasonSchema.safeParse(
    typeof details === "object" && details !== null && "capacityReason" in details
      ? details.capacityReason
      : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

// why: a worker claimed earlier in the walk, or one nothing else names, lost to the worker picked.
function passedOver(claimed: boolean, zero: WorkerReason | undefined): WorkerReason {
  return claimed || zero === undefined ? { reason: "not-chosen" } : zero;
}
