import { requestedClass, type Platform } from "../contract/index.js";
import { lineOf, type FleetWaiter } from "./queue.js";
import { matchRequest, type RoutableRequest, type RoutingDecision } from "./routing.js";
import type { WorkerView } from "./worker-registry.js";

/** why: A class request has no model to send: the worker applies its own rules to the class. */
export function forwardedModel(
  request: RoutableRequest,
  views: readonly WorkerView[],
  decision: RoutingDecision,
): ModelName {
  if (request.model === undefined || request.physical === true) return {};
  const view = views.find((worker) => worker.id === decision.workerId);
  return { model: (view === undefined ? undefined : matchRequest(view, request)) ?? request.model };
}

export interface ModelName {
  readonly model?: string;
}

// why: keyed as the core's `fitsPhysical` compares: platform, model in any letter case or else the class (`phone` when absent), and the OS text.
export function physicalMatchKey(request: FleetWaiter["request"]): string {
  const target =
    request.model === undefined
      ? `class:${requestedClass({ class: request.class })}`
      : `model:${request.model.toLowerCase()}`;
  return [request.platform, target, request.osVersion ?? ""].join("\u0000");
}

// why: a request field that is absent stays absent in the routable request (never `undefined`), as `exactOptionalPropertyTypes` needs.
function present<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function routable(waiter: FleetWaiter): RoutableRequest {
  const { request, options } = waiter;
  return {
    platform: request.platform as Platform,
    ...present({
      model: request.model,
      class: request.class,
      osVersion: request.osVersion,
      imageTag: request.imageTag,
      baseline: request.baseline,
      mode: request.mode,
      requires: options.requires,
      except: request.except,
    }),
    ...(lineOf(request) === "physical" ? { physical: true as const } : {}),
  };
}
