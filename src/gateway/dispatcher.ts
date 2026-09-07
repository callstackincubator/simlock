/**
 * The gateway's implementation of the daemon contract (ADR 0005 §32): "a second implementation
 * of the daemon contract's handlers, not a second contract". Same `runDispatch` pipeline, same
 * operation declarations, same role checks -- only the handlers differ, reading worker views
 * instead of a registry and a lease engine.
 *
 * Three populations of operations live in the table below:
 *
 * 1. **Answered from the fleet**: `status.get` and `catalog.get` (aggregated, §20/§21),
 *    `worker.*` (§8/§23), `events.*` (the gateway's own bus, which carries every worker's
 *    republished events, §22), `config.get` (the gateway's own config, §34), `token.*` (a
 *    gateway mints its own credentials, §24), and -- as of #118 -- the lease *lifecycle*
 *    (`lease.request`/`renew`/`release`/`cancel`/`release-all`) and `device.exec`, all forwarded
 *    through `FleetLeaseCoordinator`.
 * 2. **Refused permanently** (`unsupportedByDesign`): `nuke.run`, `cleanup.run`, `doctor.run`
 *    and `driver.passthrough` (§34) -- operations that act on one machine's devices as a whole.
 * 3. *(Formerly "refused until #118" -- the fleet queue, routing, and lease/exec forwarding this
 *    module now implements. Nothing is left in this population; the type below still enforces
 *    that every operation but `daemon.stop` is accounted for.)*
 *
 * `lease.list` and `list.get` read what the fleet's views and lease index report rather than
 * forwarding anything -- they are the fleet made *visible*, and #118's only change to them is
 * rewriting a gateway-issued lease's id/requester to its fleet-facing form (`FleetLeaseIndex#project`)
 * so a caller can round-trip it into `lease.renew`; a worker's own local lease is untouched.
 *
 * The one population that remains answers `UNSUPPORTED_IN_GATEWAY_MODE`; `details.operation` and
 * the message say why. The table is typed total over the contract minus `daemon.stop`, so a
 * newly declared operation is a compile error here until someone decides where it belongs.
 */
import type { z } from "zod";

import type { EventBus } from "../bus/index.js";
import { OPERATIONS, type OperationName, type tokenRecordSchema } from "../contract/index.js";
import {
  DispatchError,
  runDispatch,
  type DispatchSession,
  type ErasedHandler,
} from "../daemon/dispatch.js";
import type { Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { aggregateCatalog, aggregateStatus } from "./aggregate.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import type { WorkerRegistry } from "./worker-registry.js";

type Handler<Op extends OperationName> = (
  input: z.infer<(typeof OPERATIONS)[Op]["input"]>,
  session: DispatchSession,
) => Promise<unknown> | unknown;

type TokenRecord = z.infer<typeof tokenRecordSchema>;

type DeepReadonly<Value> = Value extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

/**
 * The config `config.get` answers with, as this module sees it: the contract's own shape, made
 * deeply readonly so `src/core`'s `Config` (which is) assigns into it. Declared this way rather
 * than by importing `Config` because `src/gateway` imports nothing from `core` (ADR 0005 §33),
 * and the gateway has no business with the type's *meaning* anyway -- it stores this value and
 * hands it back.
 */
export type GatewayConfig = DeepReadonly<z.infer<(typeof OPERATIONS)["config.get"]["output"]>>;

/**
 * The token store, structurally. Narrower than importing `TokenStore` itself (which lives under
 * `src/http` for historical reasons): the gateway needs three methods, and depending on the
 * shape rather than the class is what keeps `src/gateway` from importing a frontend.
 */
export interface GatewayTokenStore {
  create(
    role: "agent" | "operator" | "worker",
    label?: string,
  ): Promise<{ record: TokenRecord; secret: string }>;
  list(): Promise<TokenRecord[]>;
  revoke(id: string): Promise<boolean>;
}

export interface GatewayDispatcherOptions {
  /** The gateway's own config -- what `config.get` returns (ADR 0005 §34). */
  readonly config: GatewayConfig;
  readonly eventBus: EventBus;
  readonly workers: WorkerRegistry;
  readonly tokens?: GatewayTokenStore;
  /**
   * C-2, ADR 0005 §8: "revoking closes the uplink". Called after a successful `token.revoke`
   * with the revoked token's id, so any uplink that token authenticated is closed immediately
   * rather than only at that worker's next reconnect (uplinks are long-lived, so without this a
   * revoked worker token has no observable effect until the worker happens to redial). Optional
   * so a test exercising `token.revoke` in isolation, with no `GatewayService` behind it, need
   * not supply one -- revocation still writes the store either way.
   */
  readonly closeUplinksForToken?: (tokenId: string) => Promise<void>;
  readonly logger?: Logger;
  /** The gateway's own health, for `status.get`. */
  readonly health: () => "starting" | "running" | "failed";
  readonly awaitReady: () => Promise<void>;
  /**
   * #118: admission, dispatch, and lease/exec forwarding. Every lease-lifecycle handler and
   * `device.exec` below is a thin translation from contract input to a `coordinator` call; the
   * two ownership lookups (`ownerId`, `leaseRequesterId`) and the pending-request lookup
   * (`pendingRequestOwner`) it also exposes feed `dispatch()`'s `authorizeLookups` directly, the
   * same shape a worker's own `Dispatcher` supplies from its registry and queue.
   */
  readonly coordinator: Pick<
    FleetLeaseCoordinator,
    | "request"
    | "cancelPending"
    | "renew"
    | "release"
    | "releaseAll"
    | "exec"
    | "queueDepth"
    | "ownerId"
    | "leaseRequesterId"
    | "pendingRequestOwner"
  >;
  /** #118: read-only access for `lease.list`/`list.get`/`status.get`'s lease projection
   * (`FleetLeaseIndex#project`/`#all`) -- kept separate from `coordinator` because this
   * dispatcher only ever *reads* it, never mutates it. */
  readonly leaseIndex: Pick<FleetLeaseIndex, "project" | "all">;
}

export class GatewayDispatcher {
  readonly #logger: Logger;
  readonly #handlers: Record<Exclude<OperationName, "daemon.stop">, ErasedHandler>;

  constructor(private readonly options: GatewayDispatcherOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#handlers = {
      "catalog.get": this.#catalogGet,
      "status.get": this.#statusGet,
      "config.get": this.#configGet,
      "events.replay": this.#eventsReplay,
      "events.subscribe": this.#eventsSubscribe,
      "events.unsubscribe": this.#eventsUnsubscribe,
      "token.create": this.#tokenCreate,
      "token.list": this.#tokenList,
      "token.revoke": this.#tokenRevoke,
      "worker.list": this.#workerList,
      "worker.drain": this.#workerDrain,
      "worker.undrain": this.#workerUndrain,
      "worker.remove": this.#workerRemove,
      "lease.list": this.#leaseList,
      "list.get": this.#listGet,

      "nuke.run": unsupportedByDesign("nuke.run"),
      "cleanup.run": unsupportedByDesign("cleanup.run"),
      "doctor.run": unsupportedByDesign("doctor.run"),
      "driver.passthrough": unsupportedByDesign("driver.passthrough"),

      "lease.request": this.#leaseRequest,
      "lease.renew": this.#leaseRenew,
      "lease.release": this.#leaseRelease,
      "lease.cancel": this.#leaseCancel,
      "lease.release-all": this.#leaseReleaseAll,
      "device.exec": this.#deviceExec,
      // "daemon.stop" is absent for the same reason it is absent from the worker's table: the
      // transport intercepts it ahead of any dispatch (ADR 0003 §6's frozen exception).
    };
  }

  dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    return runDispatch(operation, rawInput, session, {
      handlers: this.#handlers,
      // #118: `ownsLease`/`device.exec`'s own hook and `lease.cancel`'s resolve these against
      // the fleet's own lease index and pending-request queue -- the same shape a worker's own
      // `Dispatcher` supplies from its registry and queue, read through `coordinator` instead.
      authorizeLookups: {
        leaseRequesterId: (id) => this.options.coordinator.leaseRequesterId(id),
        ownerId: (id) => this.options.coordinator.ownerId(id),
        pendingRequestOwner: (id) => this.options.coordinator.pendingRequestOwner(id),
      },
      awaitReady: () => this.options.awaitReady(),
      onOutputMismatch: (operationName, issues) => {
        this.#logger.error("Operation output failed contract validation", {
          operation: operationName,
          issues,
        });
      },
    });
  }

  // ---- handlers -----------------------------------------------------------------------------

  #statusGet: Handler<"status.get"> = () =>
    aggregateStatus(this.options.workers.views(), {
      health: this.options.health(),
      // ADR 0005 §20: the gateway's own fleet queue depth.
      queueDepth: this.options.coordinator.queueDepth,
      leaseIndex: this.options.leaseIndex,
    });

  #catalogGet: Handler<"catalog.get"> = (input) =>
    aggregateCatalog(this.options.workers.views(), input.platform);

  #configGet: Handler<"config.get"> = () => this.options.config;

  #eventsReplay: Handler<"events.replay"> = (input) =>
    this.options.eventBus.replay(input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs });

  #eventsSubscribe: Handler<"events.subscribe"> = (_input, session) => {
    const subscriptionId = session.manageEventSubscription(true);
    if (subscriptionId === undefined) {
      throw new DispatchError("INTERNAL", "Transport did not provide a subscription id");
    }
    return { subscribed: true, subscriptionId };
  };

  #eventsUnsubscribe: Handler<"events.unsubscribe"> = (_input, session) => {
    session.manageEventSubscription(false);
    return { subscribed: false };
  };

  #tokenCreate: Handler<"token.create"> = async (input) => {
    const { record, secret } = await this.#requireTokens().create(input.role, input.label);
    return { secret, token: record };
  };

  #tokenList: Handler<"token.list"> = async () => ({ tokens: await this.#requireTokens().list() });

  #tokenRevoke: Handler<"token.revoke"> = async (input) => {
    const revoked = await this.#requireTokens().revoke(input.id);
    // C-2: only a token that actually existed can have opened an uplink -- revoking an unknown
    // id (already-gone, or never real) has nothing to close, same as it has nothing to forget
    // in the store.
    if (revoked) await this.options.closeUplinksForToken?.(input.id);
    return { revoked };
  };

  #workerList: Handler<"worker.list"> = () => ({ workers: this.options.workers.views() });

  #workerDrain: Handler<"worker.drain"> = async (input) => {
    await this.options.workers.setDrained(input.workerId, true);
    return { drained: true, workerId: input.workerId };
  };

  #workerUndrain: Handler<"worker.undrain"> = async (input) => {
    await this.options.workers.setDrained(input.workerId, false);
    return { drained: false, workerId: input.workerId };
  };

  #workerRemove: Handler<"worker.remove"> = async (input) => ({
    removed: await this.options.workers.remove(input.workerId),
    workerId: input.workerId,
  });

  /**
   * ADR 0005 §14/§20: a non-admin session sees only the fleet leases *it* owns -- resolved
   * through the lease index by `ownerId`, never by scanning every worker's raw leases and
   * comparing `ownerId` to `session.principal` directly. That comparison would let an agent
   * token on the gateway that happens to name itself the same as some worker's own local agent
   * see that machine's local lease (`session.principal` is client-chosen and unverified, per
   * `daemon/server.ts`'s `hello` handling) -- the index only ever holds leases this gateway
   * itself issued, so it cannot produce that collision. An admin session sees the whole fleet,
   * which is what `GET /v1/leases` is for.
   */
  #leaseList: Handler<"lease.list"> = (_input, session) => ({
    leases:
      session.role === "admin" ? this.#fleetLeases() : this.#ownedFleetLeases(session.principal),
  });

  /** Every lease this gateway issued to `ownerId`, projected to its fleet-facing form. Looks up
   * each entry's current record from the owning worker's view rather than caching one on the
   * index itself, so a renewed TTL/`lastRenewedAt` is always current. An entry whose worker view
   * (or the specific lease on it) is momentarily missing -- a race with a reconnect rebuild, or
   * a worker that just disconnected -- is skipped rather than fabricated. */
  #ownedFleetLeases(ownerId: string) {
    const leases = [];
    for (const entry of this.options.leaseIndex.all()) {
      if (entry.ownerId !== ownerId) continue;
      const view = this.options.workers.view(entry.workerId);
      const raw = view?.leases.find((lease) => lease.id === entry.workerLeaseId);
      if (view === undefined || raw === undefined) continue;
      leases.push(this.options.leaseIndex.project(raw, view.id, view.label));
    }
    return leases;
  }

  /**
   * The admin inspection of the fleet. `devices` and `leases` are the aggregate with
   * `workerId`; `rules` is empty, because cleanup rules are a machine's own configuration and a
   * gateway runs no reaper (ADR 0005 §2) -- an empty list says "this endpoint has none", which
   * is true, where a refusal would suggest the question was wrong.
   */
  #listGet: Handler<"list.get"> = (input) => {
    switch (input.kind) {
      case "leases":
        return this.#fleetLeases();
      case "rules":
        return [];
      case "devices":
      case undefined:
        return this.options.workers
          .views()
          .flatMap((view) => view.devices.map((device) => ({ ...device, workerId: view.id })));
    }
  };

  /** Every lease every worker's view reports, each projected through the lease index -- rewritten
   * to its gateway id/requester/`worker` for a lease this gateway issued (test: "lease.list
   * rewrites ids only for gateway-issued leases"), passed through with only `workerId` added for
   * a worker's own local lease. Admin-only visibility (`list.get`, and `#leaseList` for an admin
   * session): a non-admin session never reaches this, see `#ownedFleetLeases` above. */
  #fleetLeases() {
    return this.options.workers
      .views()
      .flatMap((view) =>
        view.leases.map((lease) => this.options.leaseIndex.project(lease, view.id, view.label)),
      );
  }

  /**
   * ADR 0005 §15: "the gateway's `lease.defaultTtlMs` fills in a request that names no `ttlMs`
   * and its `lease.maxTtlMs` caps what its own clients may ask for, both before anything is
   * dispatched". `owner` (§27a) is read only from an `admin` session -- rejected outright from
   * any other role, the same gate the worker's own `#leaseRequest` applies, so a fleet client
   * cannot name someone else's principal even though a gateway's own admin uplink session must
   * be able to.
   */
  // fallow-ignore-next-line complexity -- one transaction, moved verbatim from the worker's own #leaseRequest shape.
  #leaseRequest: Handler<"lease.request"> = async (input, session) => {
    this.#requireTtlWithinCap(input.ttlMs);
    if (input.owner !== undefined && session.role !== "admin") {
      throw new DispatchError(
        "FORBIDDEN",
        "Only an admin session may set lease.request's `owner` field",
      );
    }
    return this.options.coordinator.request(
      {
        model: input.model,
        platform: input.platform,
        ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
        ...(input.full ? { full: true } : {}),
      },
      {
        allowDownload: input.allowDownload ?? false,
        noWait: input.noWait ?? false,
        ownerId: input.owner ?? session.principal,
        requesterId: input.requesterId ?? session.principal,
        ...(session.onProgress === undefined ? {} : { onProgress: session.onProgress }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        // Always explicit past this point (§15): a request that named none is filled in here,
        // before dispatch, rather than left for whichever worker happens to grant it to default
        // on its own -- which could differ fleet to fleet.
        ttlMs: input.ttlMs ?? this.options.config.lease.defaultTtlMs,
      },
    );
  };

  #leaseCancel: Handler<"lease.cancel"> = async (input, session) => {
    const requesterId = input.requesterId ?? session.principal;
    const result = await this.options.coordinator.cancelPending(requesterId);
    return { result };
  };

  /** ADR §15's cap applies here too -- "what its own clients may ask for" is any `ttlMs` a
   * fleet client names, renew included, not only the initial request. */
  #leaseRenew: Handler<"lease.renew"> = async (input) => {
    this.#requireTtlWithinCap(input.ttlMs);
    return this.options.coordinator.renew(input.leaseId, input.ttlMs);
  };

  #leaseRelease: Handler<"lease.release"> = async (input) => {
    await this.options.coordinator.release(input.leaseId);
    return { leaseId: input.leaseId };
  };

  #leaseReleaseAll: Handler<"lease.release-all"> = async () => {
    const leaseIds = await this.options.coordinator.releaseAll();
    return { leaseIds: [...leaseIds] };
  };

  /** ADR §19b: proxied to the worker that owns the device, over the same uplink as everything
   * else. Ownership was already checked once, at the gateway (this operation's own `authorize`
   * hook, via `leaseRequesterId`/`ownerId` above) -- the worker checks it again, against the
   * namespaced requester `FleetLeaseCoordinator#exec` forwards (§19a'). */
  #deviceExec: Handler<"device.exec"> = async (input, session) =>
    this.options.coordinator.exec(
      {
        leaseId: input.leaseId,
        tool: input.tool,
        args: input.args,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      },
      session,
    );

  /**
   * ADR §15/§4's cap, applied identically to a request and a renew. Lives here rather than in
   * the contract schema for the same reason the worker's own copy does: `lease.maxTtlMs` is a
   * daemon config value the contract module cannot see.
   */
  #requireTtlWithinCap(ttlMs: number | undefined): void {
    const maxTtlMs = this.options.config.lease.maxTtlMs;
    if (ttlMs !== undefined && ttlMs > maxTtlMs) {
      throw new DispatchError(
        "BAD_REQUEST",
        `ttlMs ${String(ttlMs)} exceeds lease.maxTtlMs (${String(maxTtlMs)})`,
      );
    }
  }

  #requireTokens(): GatewayTokenStore {
    if (this.options.tokens === undefined) {
      throw new DispatchError("INTERNAL", "Token store is unavailable");
    }
    return this.options.tokens;
  }
}

/** ADR 0005 §34: stays per-worker, permanently. */
function unsupportedByDesign(operation: OperationName): ErasedHandler {
  return () => {
    throw new DispatchError(
      "UNSUPPORTED_IN_GATEWAY_MODE",
      `${operation} acts on one machine's devices; run it against a worker`,
      { operation },
    );
  };
}
