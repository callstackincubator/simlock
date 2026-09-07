/**
 * `src/gateway` -- the second implementation of the daemon contract (ADR 0005 §32), for a
 * daemon that owns no devices and fronts the workers connected to it.
 *
 * Boundaries (§33, enforced by `boundary.test.ts`): nothing here imports `src/drivers`, and
 * from `src/core` nothing at all in this PR -- no registry, no capacity, no lifecycle. The only
 * daemon-side import is `daemon/dispatch.js`, the transport-facing dispatch contract, which is
 * itself core-free.
 *
 * The barrel is what the daemon entrypoint assembles a gateway out of, not a mirror of every
 * module here: `WorkerRegistry`, `WorkerLink` and the aggregation functions are wired together
 * *by* `GatewayService` and `GatewayDispatcher`, so nothing outside builds one directly, and
 * their own tests import their modules.
 */
export { FileDrainStore } from "./drain-store.js";
// fallow-ignore-next-line unused-type -- public port shape for anyone supplying their own store.
export type { DrainStore } from "./drain-store.js";
export { GatewayDispatcher } from "./dispatcher.js";
// fallow-ignore-next-line unused-type -- public option shape for anyone composing a gateway; `main.ts` builds one inline.
export type { GatewayTokenStore } from "./dispatcher.js";
export { GatewayService, type GatewayServiceOptions } from "./service.js";
// fallow-ignore-next-line unused-type -- public seam types (WorkerLink/WorkerRegistry/GatewayService satisfy them); #118's FleetLeaseCoordinator imports them directly from fleet-ports.js rather than through this barrel, so a custom implementation is this re-export's only consumer.
export type { FleetViews } from "./fleet-ports.js";
// fallow-ignore-next-line unused-type -- see FleetViews above.
export type { WorkerDirectory } from "./fleet-ports.js";
// fallow-ignore-next-line unused-type -- see FleetViews above.
export type { WorkerDispatchTarget } from "./fleet-ports.js";
export { FleetLeaseCoordinator } from "./fleet-coordinator.js";
export { FleetLeaseIndex } from "./lease-index.js";
// fallow-ignore-next-line unused-type -- public record shape for FleetLeaseIndex's own consumers; no current caller outside src/gateway needs the type by name.
export type { FleetLeaseEntry } from "./lease-index.js";
export { createRoutingPolicy, isRoutingPolicyName } from "./routing.js";
// fallow-ignore-next-line unused-export -- public registry surface (mirrors capacityStrategyNames); routing.test.ts imports it directly from routing.js, not through this barrel.
export { DEFAULT_ROUTING_POLICY, routingPolicyNames } from "./routing.js";
// fallow-ignore-next-line unused-type -- public shape for a caller implementing its own routing policy; no current one exists outside routing.ts.
export type { RoutingPolicy, RoutingPolicyName } from "./routing.js";
export { GatewayOwnerRoutedFacts } from "./owner-routed-facts.js";
