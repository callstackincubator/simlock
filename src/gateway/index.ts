/**
 * `src/gateway` -- the second implementation of the daemon contract (ADR 0005 §32), for a
 * daemon that owns no devices and fronts the workers connected to it.
 *
 * Boundaries (§33, enforced by `boundary.test.ts`): nothing here imports `src/drivers`, and
 * from `src/core` nothing at all in this PR -- no registry, no capacity, no lifecycle. The only
 * daemon-side import is `daemon/dispatch.js`, the transport-facing dispatch contract, which is
 * itself core-free.
 */
export { aggregateCatalog, aggregateStatus } from "./aggregate.js";
export { FileDrainStore, MemoryDrainStore } from "./drain-store.js";
// fallow-ignore-next-line unused-type -- public port shape for anyone supplying their own store.
export type { DrainStore } from "./drain-store.js";
export { GatewayDispatcher, type GatewayDispatcherOptions } from "./dispatcher.js";
// fallow-ignore-next-line unused-type -- public option shape for anyone composing a gateway; `main.ts` builds one inline.
export type { GatewayTokenStore } from "./dispatcher.js";
export { GatewayService, type GatewayServiceOptions } from "./service.js";
export { WorkerRegistry, type WorkerView } from "./worker-registry.js";
export { WorkerLink, type WorkerClientFactory } from "./worker-link.js";
