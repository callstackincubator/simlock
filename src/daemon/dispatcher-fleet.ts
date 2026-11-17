import { z } from "zod";

import {
  inboxItems,
  OPERATIONS,
  type OperationName,
  waitingRequestSchema,
  WORKER_VIEW_CATALOG_EVENTS,
  WORKER_VIEW_REFRESH_INTERVAL_MS,
  workerViewFields,
} from "../contract/index.js";
import { DispatchError, type DispatchSession, type ErasedHandler } from "./dispatch.js";
import { requireTokens } from "./dispatcher-admin.js";
import type { ComponentHandlers } from "./dispatcher-components.js";
import type { LeaseHandlers } from "./dispatcher-leases.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";
import type { StatusHandlers } from "./dispatcher-status.js";
import type { RelayConnection } from "./relay.js";

export class FleetHandlers {
  /**
   * why: `worker.list`'s catalog: the last `catalog.get` answer and when it was read. Kept for
   * `WORKER_VIEW_REFRESH_INTERVAL_MS`, the rhythm a gateway re-reads a worker's catalog at, and
   * dropped on `WORKER_VIEW_CATALOG_EVENTS`, the events a gateway re-reads it on. Without it
   * every `worker.list` runs each driver's catalog read (`simctl list` on iOS), and the console
   * polls that route. Holds the promise, so calls that arrive while a read runs
   * share it; a read that fails is dropped, so the next call reads again.
   */
  #viewCatalog: { readonly readAt: number; readonly catalog: Promise<unknown> } | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(
    private readonly options: DispatcherOptions,
    private readonly parts: {
      readonly status: StatusHandlers;
      readonly components: ComponentHandlers;
      readonly leases: LeaseHandlers;
    },
  ) {
    for (const event of WORKER_VIEW_CATALOG_EVENTS) {
      const unsubscribe = options.eventBus?.subscribe(event, () => {
        this.#viewCatalog = undefined;
      });
      if (unsubscribe !== undefined) this.#unsubscribe.push(unsubscribe);
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#viewCatalog = undefined;
  }

  readonly workerList: Handler<"worker.list"> = async (_input, session) => {
    // why: taken as status resolves, not after the slower catalog read, so the load is not made to look fresher.
    let receivedAt = this.options.clock.now();
    const [status, devices, catalog, baselines] = await Promise.all([
      Promise.resolve(this.parts.status.statusGet({}, session)).then((answer) => {
        receivedAt = this.options.clock.now();
        return answer;
      }),
      this.parts.status.listGet({ kind: "devices" }, session),
      this.#keptViewCatalog(session),
      this.options.baselines === undefined
        ? undefined
        : this.parts.components.baselineList({}, session),
    ]);
    const label = this.options.config.gateway.label;
    return {
      workers: [
        {
          ...workerViewFields({
            ...(baselines === undefined
              ? {}
              : { baselines: OPERATIONS["baseline.list"].output.parse(baselines) }),
            catalog: OPERATIONS["catalog.get"].output.parse(catalog),
            config: OPERATIONS["config.get"].output.parse(this.parts.status.configGet({}, session)),
            devices: OPERATIONS["list.get"].output.parse(devices),
            receivedAt,
            status: OPERATIONS["status.get"].output.parse(status),
          }),
          connection: "connected",
          drained: false,
          id: this.options.instanceId,
          lastSeenAt: this.options.clock.now(),
          version: this.options.version,
          ...(label === undefined ? {} : { label }),
        },
      ],
    };
  };

  #keptViewCatalog(session: DispatchSession): Promise<unknown> {
    const now = this.options.clock.now();
    const kept = this.#viewCatalog;
    const age = kept === undefined ? undefined : now - kept.readAt;
    if (
      kept !== undefined &&
      age !== undefined &&
      age >= 0 &&
      age < WORKER_VIEW_REFRESH_INTERVAL_MS
    ) {
      return kept.catalog;
    }
    const catalog = Promise.resolve(this.parts.status.catalogGet({}, session));
    this.#viewCatalog = { catalog, readAt: now };
    catalog.catch(() => {
      this.#viewCatalog = undefined;
    });
    return catalog;
  }

  // why: a worker answers as a fleet of one (ADR 0012): the rules read its own view, leases and queue.
  readonly inboxGet: Handler<"inbox.get"> = async (_input, session) => {
    const [listed, tokens] = await Promise.all([
      this.workerList({}, session),
      Promise.resolve()
        .then(() => requireTokens(this.options).list())
        .catch(() => []),
    ]);
    return {
      items: [
        ...inboxItems(OPERATIONS["worker.list"].output.parse(listed).workers, {
          leases: OPERATIONS["lease.list"].output.parse(this.parts.leases.leaseList({}, session))
            .leases,
          now: this.options.clock.now(),
          requests: z.array(waitingRequestSchema).parse(this.options.queue.waitingRequests()),
          tokens: OPERATIONS["token.list"].output.parse({ tokens }).tokens,
        }),
      ],
    };
  };

  #relays(session: DispatchSession): RelayConnection {
    if (session.isGatewayUplink !== true) {
      throw new DispatchError("FORBIDDEN", "Only the gateway's own uplink session may relay");
    }
    if (session.relays === undefined) {
      throw new DispatchError("INTERNAL", "The uplink session carries no relays");
    }
    return session.relays;
  }

  readonly relayRequest: Handler<"relay.request"> = (input, session) => {
    const relays = this.#relays(session);
    if (session.relayChannel === undefined) {
      throw new DispatchError(
        "BAD_REQUEST",
        `The relay's channel ${input.channel} was not accepted`,
      );
    }
    return relays.request(
      input,
      { head: (status, headers) => session.onRelayHead?.(status, headers) ?? Promise.resolve() },
      session.relayChannel,
    );
  };

  readonly relayCancel: Handler<"relay.cancel"> = (input, session) => {
    this.#relays(session).cancel(input.relayId);
    return {};
  };
}

export function unsupportedOnWorker(
  operation: OperationName,
  message = `${operation} acts on a gateway's workers, and this daemon is not a gateway`,
): ErasedHandler {
  return () => {
    throw new DispatchError("UNSUPPORTED_IN_WORKER_MODE", message, { operation });
  };
}
