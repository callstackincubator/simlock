/**
 * why: the gateway's implementation of the daemon contract (ADR 0005 §32): "a second implementation
 * of the daemon contract's handlers, not a second contract". Same `runDispatch` pipeline, same
 * operation declarations, same role checks -- only the handlers differ, reading worker views
 * instead of a registry and leasing.
 *
 * Three populations of operations live in the table below:
 *
 * 1. **Answered from the fleet**: `status.get` and `catalog.get` (aggregated, §20/§21),
 *    `worker.*` (§8/§23, and ADR 0010 §7's `worker.install-component`, relayed to the workers it
 *    names by `./component-relay.ts`), `events.*` (the gateway's own bus, which carries every worker's
 *    republished events, §22), `config.get` (the gateway's own config, §34), `token.*` (a
 *    gateway mints its own credentials, §24), `usage.get` (read from the gateway's own history by
 *    `createUsageReader`), and -- as of #118 -- the lease *lifecycle*
 *    (`lease.request`/`renew`/`release`/`cancel`/`release-all`) and `device.exec`, all forwarded
 *    through `FleetLeaseCoordinator`.
 * 2. **Refused permanently** (`unsupportedByDesign`): `nuke.run`, `cleanup.run`, `doctor.run`
 *    and `driver.passthrough` (§34) -- operations that act on one machine's devices as a whole --
 *    and `component.install` (ADR 0010 §7), which installs on one machine; its message points at
 *    `worker.install-component`, which names the workers to install on. `component.list` and
 *    `component.remove` (§8) list and remove one machine's components.
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
import type { TokenOperations } from "../auth/index.js";
import type { z } from "zod";

import { createUsageReader, type UsageReader } from "../core/index.js";
import type { EventHistoryHandle } from "../history/index.js";
import {
  consoleUrlField,
  isSimlockError,
  EVENTS_PAGE_DEFAULT,
  OPERATIONS,
  requestedDevice,
  type OperationName,
  withoutQuarantineMessages,
} from "../contract/index.js";
import {
  DispatchError,
  identityGet,
  runDispatch,
  eventsPageAnswer,
  usageAnswer,
  type DispatchSession,
  type ErasedHandler,
} from "../daemon/dispatch.js";
import type { Clock, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { aggregateCatalog, aggregateStatus, type AggregateStatusOptions } from "./aggregate.js";
import { relayComponentInstall } from "./component-relay.js";
import type { FleetLeaseCoordinator } from "./fleet-coordinator.js";
import { isUplinkLost, liveClient, type WorkerDirectory } from "./fleet-ports.js";
import type { FleetLeaseIndex } from "./lease-index.js";
import type { WorkerRegistry } from "./worker-registry.js";

type Handler<Op extends OperationName> = (
  input: z.infer<(typeof OPERATIONS)[Op]["input"]>,
  session: DispatchSession,
) => Promise<unknown> | unknown;

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

/** why: ADR 0035 §1; what `alerts.test` needs of a send, declared here because `src/gateway` may not import `src/alerts`. */
export type AlertTestOutcome =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly reason: "unknown-destination" | "stopped" | "status" | "unreachable" | "timeout";
      readonly status?: number;
      readonly error?: string;
    };

type DaemonUpdateOutput = z.infer<(typeof OPERATIONS)["daemon.update"]["output"]>;

// why: ADR 0042 §6: the gateway's own update has no lease wait and goes straight to installing; `src/daemon` supplies it.
export interface GatewayUpdate {
  request(
    input: z.infer<(typeof OPERATIONS)["daemon.update"]["input"]>,
  ): Promise<Omit<DaemonUpdateOutput, "health" | "version">>;
  state(): Pick<DaemonUpdateOutput, "lastUpdateFailure" | "latestVersion" | "update">;
}

export interface GatewayDispatcherOptions {
  readonly historyPath?: string;
  /** The gateway's own config -- what `config.get` returns (ADR 0005 §34). */
  readonly config: GatewayConfig;
  readonly eventHistory: Pick<EventHistoryHandle, "replay" | "replayPage" | "status">;
  readonly workers: WorkerRegistry;
  /**
   * why: ADR 0035 §1; declared here, not imported from `src/alerts`, which this module may not
   * import. Posts one sample to the named alert destination and says what came of it.
   */
  readonly testDestination?: (destination: string) => Promise<AlertTestOutcome>;
  /** Each worker's live link, for `worker.install-component` (ADR 0010 §7). `GatewayService`
   * satisfies it. */
  readonly directory: WorkerDirectory;
  readonly tokens?: TokenOperations;
  /**
   * C-2, ADR 0005 §8: "revoking closes the uplink". Called after a successful `token.revoke`
   * with the revoked token's id, so any uplink that token authenticated is closed immediately
   * rather than only at that worker's next reconnect (uplinks are long-lived, so without this a
   * revoked worker token has no observable effect until the worker happens to redial). Optional
   * so a test exercising `token.revoke` in isolation, with no `GatewayService` behind it, need
   * not supply one -- revocation still writes the store either way.
   */
  readonly closeUplinksForToken?: (tokenId: string) => Promise<void>;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** Classifies a thrown error for the `operation` log line (`classifyError` in production),
   * injected because `src/gateway` imports nothing from `src/core`. Unset or `undefined`:
   * `INTERNAL`. */
  readonly errorCode?: (error: unknown) => string | undefined;
  readonly health: () => "starting" | "running" | "failed";
  readonly version: string;
  readonly latestVersion: () => string | null;
  readonly update: GatewayUpdate;
  readonly host: AggregateStatusOptions["host"];
  readonly load?: () => AggregateStatusOptions["load"];
  readonly awaitReady: () => Promise<void>;
  readonly coordinator: Pick<
    FleetLeaseCoordinator,
    | "request"
    | "cancelPending"
    | "renew"
    | "release"
    | "releaseAll"
    | "exec"
    | "queueDepth"
    | "physicalQueueDepth"
    | "ownerId"
    | "leaseRequesterId"
    | "pendingRequestOwner"
    | "waitingRequests"
  >;
  readonly leaseIndex: Pick<
    FleetLeaseIndex,
    "project" | "all" | "isGatewayRequester" | "requesterPrefix" | "resolve" | "findByWorkerLease"
  >;
}

const UNKNOWN_DESTINATION: AlertTestOutcome = { ok: false, reason: "unknown-destination" };

function alertTestError(
  destination: string,
  result: Extract<AlertTestOutcome, { ok: false }>,
): DispatchError {
  switch (result.reason) {
    case "unknown-destination":
      return new DispatchError(
        "UNKNOWN_ALERT_DESTINATION",
        `No alert destination named "${destination}". Check gateway.alerts.destinations in the gateway's config.`,
        { destination },
      );
    case "stopped":
      return new DispatchError("DAEMON_STOPPING", "Gateway is stopping");
    case "status":
      return new DispatchError(
        "ALERT_SEND_FAILED",
        `${destination} answered HTTP ${result.status}`,
        {
          destination,
          status: result.status,
        },
      );
    case "timeout":
      return new DispatchError("ALERT_SEND_FAILED", `${destination} did not answer within 10 s`, {
        destination,
        error: "timeout",
      });
    case "unreachable": {
      const error = result.error ?? "network-error";
      return new DispatchError(
        "ALERT_SEND_FAILED",
        `${destination} could not be reached: ${error}`,
        {
          destination,
          error,
        },
      );
    }
  }
}

const UPDATE_UPLINK_BOUND_MS = 90_000;

export class GatewayDispatcher {
  readonly #logger: Logger;
  readonly #dispatchLogger: Logger;
  readonly #handlers: Record<Exclude<OperationName, "daemon.stop">, ErasedHandler>;
  readonly #usage: UsageReader;

  constructor(private readonly options: GatewayDispatcherOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#usage = createUsageReader({
      fleet: { requesterPrefix: options.leaseIndex.requesterPrefix },
      historyPath: options.historyPath ?? "",
      opened: () => options.historyPath !== undefined && options.eventHistory.status().opened,
      tokenLabels: async () =>
        new Map(
          ((await options.tokens?.list()) ?? []).flatMap((token) =>
            token.label === undefined ? [] : [[token.id, token.label] as const],
          ),
        ),
      workers: () =>
        options.workers.views().map(({ id, label }) => ({
          id,
          ...(label === undefined ? {} : { label }),
        })),
    });
    this.#dispatchLogger = this.#logger.child("dispatch");
    this.#handlers = {
      "catalog.get": this.#catalogGet,
      "status.get": this.#statusGet,
      "config.get": this.#configGet,
      "events.replay": this.#eventsReplay,
      "usage.get": this.#usageGet,
      "events.subscribe": this.#eventsSubscribe,
      "events.unsubscribe": this.#eventsUnsubscribe,
      "token.create": this.#tokenCreate,
      "token.list": this.#tokenList,
      "token.revoke": this.#tokenRevoke,
      "worker.list": this.#workerList,
      "worker.drain": this.#workerDrain,
      "worker.undrain": this.#workerUndrain,
      "worker.remove": this.#workerRemove,
      "worker.update": this.#workerUpdate,
      "alerts.test": this.#alertsTest,
      "daemon.update": this.#daemonUpdate,
      "worker.install-component": this.#workerInstallComponent,
      "lease.list": this.#leaseList,
      "lease.get": this.#leaseGet,
      "list.get": this.#listGet,
      "identity.get": identityGet,

      "nuke.run": unsupportedByDesign("nuke.run"),
      "cleanup.run": unsupportedByDesign("cleanup.run"),
      "doctor.run": unsupportedByDesign("doctor.run"),
      "driver.passthrough": unsupportedByDesign("driver.passthrough"),
      // ADR 0010 §7: a gateway owns no components and has no download policy of its own.
      "component.install": unsupportedByDesign(
        "component.install",
        "component.install installs on one machine; on a gateway, name the workers to install on " +
          "(simlock component install --worker <id> or --all-workers)",
      ),
      "component.list": unsupportedByDesign(
        "component.list",
        "component.list lists one machine's components; run it against a worker",
      ),
      "component.remove": unsupportedByDesign(
        "component.remove",
        "component.remove removes a component from one machine; run it against a worker",
      ),
      // A device is plugged into one machine, and a gateway asks no worker.
      "device.add": unsupportedByDesign(
        "device.add",
        "device.add enrols a device plugged into one machine; run it on the worker the device is plugged into",
      ),
      "device.remove": unsupportedByDesign(
        "device.remove",
        "device.remove unenrols a device plugged into one machine; run it on the worker the device is plugged into",
      ),

      "lease.request": this.#leaseRequest,
      "lease.renew": this.#leaseRenew,
      "lease.release": this.#leaseRelease,
      "lease.cancel": this.#leaseCancel,
      "lease.release-all": this.#leaseReleaseAll,
      "device.exec": this.#deviceExec,
      "relay.request": relayRefused,
      "relay.cancel": relayRefused,
      // "daemon.stop" is absent for the same reason it is absent from the worker's table: the
      // transport intercepts it ahead of any dispatch (ADR 0003 §6's frozen exception).
    };
  }

  dispose(): void {
    void this.#usage.stop();
  }

  dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    return runDispatch(operation, rawInput, session, {
      handlers: this.#handlers,
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
      observe: {
        clock: this.options.clock,
        logger: this.#dispatchLogger,
        codeOf: (error) => this.options.errorCode?.(error) ?? "INTERNAL",
      },
    });
  }

  #statusGet: Handler<"status.get"> = (_input, session) => {
    const consoleUrl = consoleUrlField(this.options.config.http);
    const load = this.options.load?.();
    const loadField = load === undefined ? {} : { load };
    const history = this.options.eventHistory.status();
    if (this.options.health() === "starting") {
      return {
        daemon: {
          health: "starting",
          mode: "gateway",
          version: this.options.version,
          ...this.options.update.state(),
          ...consoleUrl,
        },
        history,
        host: this.options.host,
        ...loadField,
      };
    }
    const status = aggregateStatus(this.options.workers.views(), {
      health: this.options.health(),
      version: this.options.version,
      latestVersion: this.options.latestVersion(),
      progress: this.options.update.state(),
      host: this.options.host,
      ...(load === undefined ? {} : { load }),
      physicalQueueDepth: this.options.coordinator.physicalQueueDepth,
      queueDepth: this.options.coordinator.queueDepth,
      waiting: [...this.options.coordinator.waitingRequests()],
      leaseIndex: this.options.leaseIndex,
    });
    const answer = { ...status, daemon: { ...status.daemon, ...consoleUrl }, history };
    return session.role === "agent" ? withoutQuarantineMessages(answer) : answer;
  };

  #catalogGet: Handler<"catalog.get"> = (input) =>
    aggregateCatalog(this.options.workers.views(), input.platform);

  #configGet: Handler<"config.get"> = () => this.options.config;

  #usageGet: Handler<"usage.get"> = (input) => usageAnswer(this.#usage.get(input));

  #eventsReplay: Handler<"events.replay"> = (input) =>
    input.beforeId === undefined && input.limit === undefined
      ? this.options.eventHistory.replay(
          input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs },
        )
      : eventsPageAnswer(
          this.options.eventHistory.replayPage({
            ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
            limit: input.limit ?? EVENTS_PAGE_DEFAULT,
          }),
        );

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

  #daemonUpdate: Handler<"daemon.update"> = async (input) => ({
    ...(await this.options.update.request(input)),
    health: this.options.health(),
    version: this.options.version,
  });

  #workerUpdate: Handler<"worker.update"> = async (input) => {
    const view = this.options.workers.view(input.workerId);
    if (view === undefined) {
      throw new DispatchError("UNKNOWN_WORKER", `Unknown worker: ${input.workerId}`, {
        workerId: input.workerId,
      });
    }
    const target = this.options.directory.target(input.workerId);
    const client = liveClient(target);
    if (view.connection === "disconnected" || client === undefined || target === undefined) {
      throw new DispatchError("WORKER_NOT_CONNECTED", `worker ${input.workerId} is not connected`, {
        workerId: input.workerId,
      });
    }
    const { workerId, ...request } = input;
    const answer = await this.#withinUplinkBound(
      client.updateDaemon(request).catch((error: unknown) => {
        throw relayedUpdateError(error, workerId);
      }),
      workerId,
    );
    this.options.workers.refreshUpdate(workerId, answer);
    await target.refresh();
    return { ...answer, workerId };
  };

  // why: above the worker's own npm `view` and `root -g` (30 s each); at the limit the view catches up on the next read.
  #withinUplinkBound<Value>(call: Promise<Value>, workerId: string): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      const timer = this.options.clock.setTimer(UPDATE_UPLINK_BOUND_MS, () => {
        reject(
          new DispatchError(
            "WORKER_NOT_CONNECTED",
            `worker ${workerId} did not answer within 90 s; check simlock worker list`,
            { workerId },
          ),
        );
      });
      call.then(
        (value) => {
          this.options.clock.cancel(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.options.clock.cancel(timer);
          reject(error);
        },
      );
    });
  }

  #alertsTest: Handler<"alerts.test"> = async (input) => {
    const { destination } = input;
    const result = (await this.options.testDestination?.(destination)) ?? UNKNOWN_DESTINATION;
    if (result.ok) return { destination, status: result.status };
    throw alertTestError(destination, result);
  };

  #workerRemove: Handler<"worker.remove"> = async (input) => ({
    removed: await this.options.workers.remove(input.workerId),
    workerId: input.workerId,
  });

  /** ADR 0010 §7: the gateway asks each worker; each worker's own policy decides. The HTTP
   * stream opens once the targets are resolved, which is this session's `onStarted`. */
  #workerInstallComponent: Handler<"worker.install-component"> = (input, session) =>
    relayComponentInstall(
      {
        clock: this.options.clock,
        directory: this.options.directory,
        views: this.options.workers,
      },
      input,
      { onAsking: session.onStarted, onProgress: session.onComponentProgress },
    );

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

  // why: the one place a gateway lease record gets `workerLeaseId` (the worker's own id), so `lease.list`, `lease.get` and `list.get kind=leases` agree and `status.get` (which calls `project` directly) does not carry it.
  #fleetLease<Lease extends { readonly id: string; readonly requesterId: string }>(
    raw: Lease,
    view: { readonly id: string; readonly label?: string | undefined },
  ) {
    return {
      ...this.options.leaseIndex.project(raw, view.id, view.label),
      workerLeaseId: raw.id,
    };
  }

  // why: finds the record `lease.list` would hold for this session without building the list -- a gateway-issued lease through the index (its owner, or an admin), a worker's own local lease for an admin only, by a raw id the index does not rename.
  #leaseGet: Handler<"lease.get"> = (input, session) => {
    const isAdmin = session.role === "admin";
    const entry = this.options.leaseIndex.resolve(input.leaseId);
    const lease =
      entry === undefined
        ? isAdmin
          ? this.#localLease(input.leaseId)
          : undefined
        : isAdmin || entry.ownerId === session.principal
          ? this.#issuedLease(entry)
          : undefined;
    if (lease === undefined) {
      throw new DispatchError("UNKNOWN_LEASE", `Unknown lease: ${input.leaseId}`, {
        leaseId: input.leaseId,
      });
    }
    return { lease };
  };

  #issuedLease(entry: { readonly workerId: string; readonly workerLeaseId: string }) {
    const view = this.options.workers.view(entry.workerId);
    const raw = view?.leases?.find((lease) => lease.id === entry.workerLeaseId);
    return view === undefined || raw === undefined ? undefined : this.#fleetLease(raw, view);
  }

  #localLease(leaseId: string) {
    for (const view of this.options.workers.views()) {
      const raw = view.leases?.find((lease) => lease.id === leaseId);
      if (
        raw !== undefined &&
        this.options.leaseIndex.findByWorkerLease(view.id, raw.id) === undefined
      ) {
        return this.#fleetLease(raw, view);
      }
    }
    return undefined;
  }

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
      const raw = view?.leases?.find((lease) => lease.id === entry.workerLeaseId);
      if (view === undefined || raw === undefined) continue;
      leases.push(this.#fleetLease(raw, view));
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
      case "requests":
        return this.#fleetWaiting();
      case "devices":
      case undefined:
        return this.options.workers
          .views()
          .flatMap((view) =>
            (view.devices ?? []).map((device) => ({ ...device, workerId: view.id })),
          );
    }
  };

  /**
   * The fleet queue's requests, then each worker's own queue, each of those with its `workerId`.
   * A worker lists a request this gateway sent it under the gateway's own requester id (ADR 0005
   * §27); the gateway already lists that request, so the worker's copy is left out.
   */
  #fleetWaiting() {
    const { leaseIndex } = this.options;
    const onWorkers = this.options.workers
      .views()
      .flatMap((view) =>
        (view.waiting ?? [])
          .filter((request) => !leaseIndex.isGatewayRequester(request.requesterId))
          .map(({ workers: _workers, ...request }) => ({ ...request, workerId: view.id })),
      );
    return [...this.options.coordinator.waitingRequests(), ...onWorkers];
  }

  /** Every lease every worker's view reports, each projected through the lease index -- rewritten
   * to its gateway id/requester/`worker` for a lease this gateway issued (test: "lease.list
   * rewrites ids only for gateway-issued leases"), passed through with only `workerId` added for
   * a worker's own local lease. Admin-only visibility (`list.get`, and `#leaseList` for an admin
   * session): a non-admin session never reaches this, see `#ownedFleetLeases` above. */
  #fleetLeases() {
    return this.options.workers
      .views()
      .flatMap((view) => (view.leases ?? []).map((lease) => this.#fleetLease(lease, view)));
  }

  /**
   * ADR 0005 §15: "the gateway's `lease.defaultTtlMs` fills in a request that names no `ttlMs`
   * and its `lease.maxTtlMs` caps what its own clients may ask for, both before anything is
   * dispatched". `owner` (§27a, narrowed round 3 review H3) is read only from `session.
   * isGatewayUplink` -- never merely `role === "admin"`, which HTTP's `operator` token also maps
   * onto (`dispatcher-session.ts`), the same over-wide gate `daemon/dispatcher.ts`'s own
   * `#leaseRequest` used to share with this one.
   *
   * Unlike the worker, nothing ever forwards *into* a gateway's own front door the way this
   * gateway forwards into a worker -- there is no "gateway of gateways" in ADR 0005, so no
   * session reaching this handler is ever the uplink `isGatewayUplink` identifies (that flag is
   * stamped only on a worker's own `DaemonServer#acceptUplink` connection, never on a gateway's).
   * The practical effect is what the user's decision asked for stated plainly: `owner` is
   * unconditionally `FORBIDDEN` here, admin included -- a fleet client's own principal
   * (`session.principal`, the default below) is already the correct, un-spoofable owner for
   * anything this gateway itself issues.
   */
  // fallow-ignore-next-line complexity -- one transaction, moved verbatim from the worker's own #leaseRequest shape.
  #leaseRequest: Handler<"lease.request"> = async (input, session) => {
    this.#requireTtlWithinCap(input.ttlMs);
    if (input.owner !== undefined && session.isGatewayUplink !== true) {
      throw new DispatchError(
        "FORBIDDEN",
        "Only the gateway's own uplink session may set lease.request's `owner` field",
      );
    }
    // ADR 0021 §1: gateways do not chain, so no session may send the field a gateway puts on its
    // own dispatch to a worker. Refused whatever `noWait` says, as on a worker.
    if (input.fleetRequestId !== undefined) {
      throw new DispatchError(
        "FORBIDDEN",
        "A gateway does not accept lease.request's `fleetRequestId` field: only a gateway sets it, on its own dispatch to a worker",
      );
    }
    return this.options.coordinator.request(
      // Forwarded as it arrived (ADR 0007 §2): the gateway has no default mode of its own, and
      // relays an image tag unread.
      requestedDevice(input),
      {
        // `input.allowDownload` stays accepted and is not passed on: only installed runtimes
        // count through a gateway (ADR 0009 §3).
        noWait: input.noWait ?? false,
        ownerId: input.owner ?? session.principal,
        requesterId: input.requesterId ?? session.principal,
        ...(session.onProgress === undefined ? {} : { onProgress: session.onProgress }),
        ...(session.onRequestAdmitted === undefined
          ? {}
          : { onAdmitted: session.onRequestAdmitted }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        // ADR 0020: forwarded to the worker as sent, and the gateway's own lease ID when it grants.
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        ...(input.requires === undefined ? {} : { requires: input.requires }),
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

  #requireTokens(): TokenOperations {
    if (this.options.tokens === undefined) {
      throw new DispatchError("INTERNAL", "Token store is unavailable");
    }
    return this.options.tokens;
  }
}

/** ADR 0005 §34: stays per-worker, permanently. */
function unsupportedByDesign(
  operation: OperationName,
  message = `${operation} acts on one machine's devices; run it against a worker`,
): ErasedHandler {
  return () => {
    throw new DispatchError("UNSUPPORTED_IN_GATEWAY_MODE", message, { operation });
  };
}

// why: relays run from a gateway to its workers, so a gateway's own front door has none.
function relayRefused(): never {
  throw new DispatchError("FORBIDDEN", "A gateway does not accept relay operations");
}

// why: a worker's refusal keeps its code and message so HTTP and the CLI answer it as the worker would (409, 502); a link that closed under the call
// never answered, so it is WORKER_NOT_CONNECTED like the 90 s limit.
function relayedUpdateError(error: unknown, workerId: string): unknown {
  if (!isSimlockError(error)) return error;
  if (isUplinkLost(error)) {
    return new DispatchError("WORKER_NOT_CONNECTED", `worker ${workerId} is not connected`, {
      workerId,
    });
  }
  return new DispatchError(error.code, error.message, error.details);
}
