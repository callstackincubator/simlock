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
 *    gateway mints its own credentials, §24).
 * 2. **Refused permanently** (`unsupportedByDesign`): `nuke.run`, `cleanup.run`, `doctor.run`
 *    and `driver.passthrough` (§34) -- operations that act on one machine's devices as a whole.
 * 3. **Refused until #118** (`unsupportedUntilRouting`): the lease *lifecycle* --
 *    `lease.request`, `renew`, `release`, `cancel`, `release-all` -- and `device.exec`, which
 *    a gateway proxies to the worker that owns the device (§19b). The fleet queue, routing and
 *    forwarding are that PR's; this one deliberately makes the fleet visible before it is
 *    routable.
 *
 * The read-only members of the lease family -- `lease.list` and `list.get` -- are in the first
 * population, not the third: they are the fleet made *visible*, which is this PR's whole point,
 * and answering them needs nothing but the views. They read what workers report rather than
 * forwarding anything, so #118 replaces their implementation (with its own lease index) without
 * changing what a caller sees.
 *
 * The last two answer `UNSUPPORTED_IN_GATEWAY_MODE`; `details.operation` and the message say
 * which population an answer came from. The table is typed total over the contract minus
 * `daemon.stop`, so a newly declared operation is a compile error here until someone decides
 * which of the three it belongs to.
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

      "lease.request": unsupportedUntilRouting("lease.request"),
      "lease.renew": unsupportedUntilRouting("lease.renew"),
      "lease.release": unsupportedUntilRouting("lease.release"),
      "lease.cancel": unsupportedUntilRouting("lease.cancel"),
      "lease.release-all": unsupportedUntilRouting("lease.release-all"),
      "device.exec": unsupportedUntilRouting("device.exec"),
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
      // No `authorizeLookups`: the gateway holds no leases and no pending requests of its own
      // in this PR, so both lookups answer `undefined`, which every `authorize` hook treats as
      // authorized -- and every operation carrying one is refused here anyway. #118 supplies
      // the real lookups along with the lease index they read.
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
      // ADR 0005 §20: the *gateway's* queue depth. It has no queue until #118, and 0 is the
      // honest answer for a queue that cannot hold anything -- not a placeholder.
      queueDepth: 0,
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
   * Every lease the fleet's views report, each carrying its `workerId` (ADR 0005 §20), for an
   * admin session. A non-admin session sees none of them.
   *
   * P-1 (third review round): P2's version of this handler compared a namespaced form of the
   * session's own principal (`gatewayRequesterPrefix` + `session.principal`) against each
   * lease's `ownerId` -- but on a worker, `ownerId` is the *raw*, un-namespaced local principal
   * (`daemon/dispatcher.ts`'s own `lease.list`), and the gateway's own principal at `hello` is
   * `gw:<instanceId>` with no `:<requester>` suffix (`GatewayService`). A string ending in
   * `:<principal>` can therefore never equal `gw:<instanceId>`, so that comparison returned
   * `[]` for every non-admin session *by construction* -- not "until #118", as its comment
   * claimed -- and nothing exercised it except a test that hand-built an `ownerId` no code path
   * actually produces. #118 replaces this handler outright with its own `FleetLeaseIndex`,
   * filtered by `ownerId` for the real, routed case; this handler is deliberately left inert
   * rather than growing a second, competing namespacing scheme #118 would then have to undo.
   * Same observable behavior as before (`[]`), no comparison pretending to be live.
   */
  #leaseList: Handler<"lease.list"> = (_input, session) => ({
    leases: session.role === "admin" ? this.#fleetLeases() : [],
  });

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

  #fleetLeases() {
    return this.options.workers
      .views()
      .flatMap((view) => view.leases.map((lease) => ({ ...lease, workerId: view.id })));
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

/** Answered once #118 gives the gateway a queue, a routing policy, and lease forwarding. */
function unsupportedUntilRouting(operation: OperationName): ErasedHandler {
  return () => {
    throw new DispatchError(
      "UNSUPPORTED_IN_GATEWAY_MODE",
      `${operation} is not available on a gateway yet; fleet routing implements it`,
      { operation },
    );
  };
}
