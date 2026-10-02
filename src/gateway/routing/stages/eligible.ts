import type { FilterStage } from "../pipeline.js";

/**
 * The policy before ADR 0009 §2 and §3, kept only so the conformance tests can run the three
 * legacy stages (`routing.test.ts`, `routing/warm-then-free.test.ts`). No registered policy uses
 * it: `takes-requests` and `can-serve` replace it.
 *
 * Drops a worker that is disconnected, incompatible, or drained; that lacks the requested
 * platform in its catalog at all; that lacks the requested `model`; that lacks the requested
 * `osVersion` (when the request named one) among its reported runtimes; or whose own
 * `downloads.policy` would refuse the download filling either gap would need, unless the request
 * did not ask to allow one anyway. A worker whose capacity has never been read (`capacity` absent
 * -- never actually observed in practice once a view exists, but `WorkerView`'s own schema allows
 * it) is dropped too: a policy that cannot see free capacity must not guess it has some
 * (`safety.md`'s fail-closed instinct, applied to routing rather than destruction).
 */
export const eligible: FilterStage = {
  // fallow-ignore-next-line complexity -- `isEligible` from before stages, moved unchanged (#189).
  keeps(worker, request) {
    if (worker.connection !== "connected") return false;
    if (worker.drained) return false;
    if (worker.capacity === undefined) return false;
    const catalog = worker.catalog.find((entry) => entry.platform === request.platform);
    if (catalog === undefined) return false;
    const hasModel = catalog.models.includes(request.model);
    const hasRuntime =
      request.osVersion === undefined || catalog.runtimes.includes(request.osVersion);
    if (hasModel && hasRuntime) return true;
    // Missing the model or the runtime: only still eligible if this request may fill the gap
    // with a download, and this worker's own policy would permit one (ADR 0005 §13: "a download
    // is considered only on a worker whose download policy allows it"). An unread policy is
    // treated as `"never"` -- the same fail-closed default `downloads.policy` itself defaults
    // away from, but the right one for a view this gateway could not actually confirm.
    return request.allowDownload && (worker.downloads?.policy ?? "never") !== "never";
  },
  kind: "filter",
  name: "eligible",
};
