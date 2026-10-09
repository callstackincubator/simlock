/**
 * One worker's uplink, from the gateway's side (ADR 0005 §5, §7, §22, §31).
 *
 * Over the uplink the gateway is the protocol *client*: this class drives the worker's own
 * dispatcher with the same typed admin client a supervisor process uses over a unix socket
 * (`connectSimlockAdmin`), which is the whole reason the fleet needs no second API. What it
 * does with that client is exactly what §7 prescribes -- `status.get`, `list.get`,
 * `catalog.get` and `events.subscribe` on connect, a refresh on every worker event that can
 * change capacity, leases or installs (ADR 0010 §7), and a periodic refresh as a backstop -- plus §22's republishing of
 * those events onto the gateway's own bus with `workerId` added.
 *
 * One call §7 does not name is here too: `config.get`, for the worker's `downloads.policy`,
 * `downloads.timeoutMs` and `lease.maxTtlMs`, read with the catalog: on connect, on every
 * periodic refresh, and after `component.installed`. The policy is shown on the view for display
 * only: routing counts installed runtimes and never reads it (ADR 0009 §3). The uplink session is
 * admin, so the gateway may read it.
 */
import type { EventBus, EventName } from "../bus/index.js";
import {
  grantedDeviceSchema,
  isSimlockError,
  WORKER_VIEW_CATALOG_EVENTS,
  workerViewFields,
} from "../contract/index.js";
import type { SimlockAdminClient, StatusGetOutput } from "../admin/index.js";
import { connectSimlockAdmin } from "../admin/index.js";
import type { AcceptedUplink, Clock, IpcConnection, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { WorkerGrantedDevice, WorkerRegistry } from "./worker-registry.js";

/**
 * How long the gateway waits for one round trip to a worker before giving up on it.
 * `SimlockWire` keeps no per-call timeout of its own (ADR 0003 leaves that to the caller), so a
 * call on a half-open socket the OS has not yet reported dead can otherwise hang forever. Two
 * findings from #117's first review round share this one root cause: a hung `events.unsubscribe`
 * stalls `close()` behind an RPC that will never answer, which is what widens a stale link's
 * window from microseconds to minutes before its `onClose` ever fires (the D1 reconnect bug);
 * and a hung refresh round trip latches `#refreshing` forever, freezing a view that still claims
 * to be `connected`. Ten seconds is far above any real round trip and far below the kind of gap
 * that turns "briefly stale" into "silently wrong".
 */
export const WORKER_CALL_TIMEOUT_MS = 10_000;

/**
 * P1/C-1: how many consecutive *transport-liveness* failures are allowed before the gateway
 * gives up on this link and closes it -- specifically, `status.get` itself timing out, not the
 * batch of calls behind it. `runDispatch` (`dispatch.ts`) parks every operation except
 * `status.get` behind the worker's startup-readiness gate, so on a worker mid-`converge` (a
 * per-device shell-out plus capacity shutdowns, routinely tens of seconds) `list.get`,
 * `catalog.get`, `config.get` and `events.subscribe` can all be genuinely, harmlessly slow while
 * the transport itself is fine. `#rebuildView` awaits `status.get` on its own, ahead of the rest
 * of the refresh, and resets `#consecutiveRefreshTimeouts` to zero the instant it answers -- so a
 * worker that is merely busy converging never counts against this limit at all, no matter how
 * long its startup gate stays shut. Only `status.get` itself failing to answer counts.
 *
 * One is not enough -- D3's single hung `status.get` recovering on its very next attempt is a
 * real, common case (a worker briefly slow, not a half-open socket) and must not tear the link
 * down for it. But nothing was acting on a *repeated* timeout either: a half-open uplink (NAT
 * rebind, a cable pull, a kernel panic -- no FIN) has every `status.get` time out forever while
 * `connection` keeps reporting `connected` with a `lastSeenAt` that never moves again. Two in a
 * row means two consecutive refresh attempts each got no answer to `status.get` at all -- and
 * since a refresh is triggered either by a worker event (immediately) or by the periodic tick
 * backstop (`refreshIntervalMs`, 30s by default), the wall-clock gap between those two failures
 * can be anywhere from milliseconds (events firing on an already-dead link) up to roughly two
 * tick intervals, not a fixed "one minute" -- that figure assumed a single bundled timeout per
 * tick, which is exactly the bundling this fix removes.
 */
export const MAX_CONSECUTIVE_REFRESH_TIMEOUTS = 2;

class WorkerCallTimeoutError extends Error {
  constructor(what: string) {
    super(`Timed out waiting for the worker's ${what}`);
    this.name = "WorkerCallTimeoutError";
  }
}

/** How the gateway turns an accepted uplink into a driven session. Injected so a test can
 * script a worker without a `DaemonServer` behind it. */
export type WorkerClientFactory = (
  connection: IpcConnection,
  principal: string,
) => Promise<SimlockAdminClient>;

export interface WorkerLinkOptions {
  readonly uplink: AcceptedUplink;
  readonly registry: WorkerRegistry;
  readonly eventBus: EventBus;
  readonly clock: Clock;
  /** The principal the gateway announces at `hello`, namespaced by its own instance id, so a
   * worker's logs attribute what the gateway did to the gateway (ADR 0005 §27's shape). */
  readonly principal: string;
  readonly logger?: Logger;
  readonly connect?: WorkerClientFactory;
  /** Called once, when this uplink closes for any reason. */
  readonly onClosed?: (workerId: string) => void;
  /**
   * Whether the owning `GatewayService` still considers this link the current one for its
   * worker id. A worker's uplink is keyed by worker id, not by link, so a reconnect that
   * replaces this link with a newer one leaves this one to close on its own time -- a stale
   * TCP path can take minutes to be reported dead (D1). Without this guard that late close
   * would call `registry.disconnected` on a worker id a newer, live link now owns, and nothing
   * would ever correct it: `refresh()` never touches `connection`. Defaults to "yes" so a
   * caller that never replaces links (every test that does not exercise a reconnect) need not
   * supply one.
   */
  readonly isCurrentLink?: () => boolean;
}

/** The `list.get` answer narrowed to the grant shape rather than the view's device shape, which keeps `driverDeviceId`
 * for the lease payload a gateway serves its holder (`GET /v1/leases/{id}`). Kept off the view,
 * in the registry beside it: see `WorkerGrantedDevice`. `list.get`'s contract also admits a
 * device without `driverDeviceId`, so one that does not parse is left out on its own rather than
 * failing the view's refresh; its lease then answers `UNKNOWN_LEASE` rather than a made-up udid. */
function grantedDevices(devices: readonly unknown[]): WorkerGrantedDevice[] {
  return devices.flatMap((device) => {
    const parsed = grantedDeviceSchema.safeParse(device);
    return parsed.success ? [parsed.data] : [];
  });
}

export class WorkerLink {
  readonly workerId: string;
  readonly #logger: Logger;
  #client: SimlockAdminClient | undefined;
  #unsubscribeEvents: (() => Promise<void>) | undefined;
  #closed = false;
  #refreshing = false;
  /** The one follow-up refresh queued behind the one in flight, if any, and the promise every
   * caller that queued it waits on. */
  #queuedRefresh: QueuedRefresh | undefined;
  /** P1/C-1: consecutive `status.get` timeouts, reset to 0 the instant any `status.get` answers
   * (inside `#rebuildView`) rather than only once a whole refresh completes -- see
   * `MAX_CONSECUTIVE_REFRESH_TIMEOUTS`'s comment for why liveness is judged on that one call. */
  #consecutiveRefreshTimeouts = 0;

  constructor(private readonly options: WorkerLinkOptions) {
    this.workerId = options.uplink.workerId;
    this.#logger = options.logger ?? new NoopLogger();
  }

  /** `./fleet-ports.ts`'s `WorkerDispatchTarget#reachable` -- false once this link is closing or
   * closed (`close()`/`#handleClosed` both set `#closed` before anything else). Read by #118's
   * `FleetLeaseCoordinator` through that interface, which is a structural access `fallow`'s
   * audit cannot follow -- hence the ignore below. */
  // fallow-ignore-next-line unused-class-member -- reached only through the `WorkerDispatchTarget` interface (FleetLeaseCoordinator); the audit cannot follow a member access through that.
  get reachable(): boolean {
    return !this.#closed;
  }

  /** C-2: the join token record id that authenticated this uplink at upgrade, or `undefined`
   * when `authenticate` returned the bare outcome string rather than naming one. Read by
   * `GatewayService#closeLinksForToken` so a revoked token can find every link it opened. */
  get tokenId(): string | undefined {
    return this.options.uplink.tokenId;
  }

  /** `./fleet-ports.ts`'s `WorkerDispatchTarget#client` -- the gateway's own admin session on
   * this worker, the same one `#rebuildView`'s refresh round trips use and the one #118's
   * `FleetLeaseCoordinator` forwards every lease/exec operation through. `undefined` before
   * `start()` has assigned it or after `close()`/`#handleClosed` has run -- neither clears
   * `#client` itself, so this mirrors `reachable` rather than checking it separately. */
  // fallow-ignore-next-line unused-class-member -- reached only through the `WorkerDispatchTarget` interface (FleetLeaseCoordinator); the audit cannot follow a member access through that.
  client(): SimlockAdminClient | undefined {
    return this.#closed ? undefined : this.#client;
  }

  /**
   * Completes the handshake and builds the first view. Never throws: a worker that cannot be
   * driven is a fact about the fleet, reported in its view and its log line, not an error the
   * gateway's accept path has to survive.
   */
  async start(): Promise<void> {
    this.options.uplink.connection.onClose(() => this.#handleClosed());
    const connect = this.options.connect ?? defaultConnect;
    let client: SimlockAdminClient;
    try {
      // C3: bounded like every other call this class makes (see `WORKER_CALL_TIMEOUT_MS`) --
      // `hello` is a round trip too, and a peer that completes the WebSocket upgrade with a
      // valid join token and then never answers it would otherwise hang `start()` forever,
      // holding an open socket and a slot in `#links` with no view to show for it (D2's failure
      // mode, one call earlier in this same method).
      client = await this.#withTimeout(
        connect(this.options.uplink.connection, this.options.principal),
        "hello",
      );
    } catch (error: unknown) {
      // A `hello` that failed for any reason other than version negotiation (see below): there
      // is no session to drive, so there is nothing to put in a view either.
      this.#logger.warn("Worker uplink handshake failed", {
        workerId: this.workerId,
        message: errorMessage(error),
      });
      await this.close();
      return;
    }
    this.#client = client;

    // ADR 0003 §6's degraded client is how a version mismatch surfaces: `connectSimlockAdmin`
    // keeps the connection open and every call rejects with the captured
    // `PROTOCOL_VERSION_UNSUPPORTED`, carrying both ranges. One call is therefore the probe
    // *and* the first `status.get` -- so a compatible worker pays nothing for the check.
    try {
      // The result is deliberately discarded: this call exists to *fail* on a mismatched
      // protocol, and the view is built by the full refresh below rather than from half a
      // snapshot taken before the event subscription exists. Bounded like every other call this
      // class makes (see `WORKER_CALL_TIMEOUT_MS`): a worker that never answers `status.get` at
      // all must not hang the handshake forever.
      await this.#withTimeout(client.getStatus(), "status.get");
    } catch (error: unknown) {
      if (isSimlockError(error) && error.code === "PROTOCOL_VERSION_UNSUPPORTED") {
        // ADR 0005 §31: marked `incompatible`, with both ranges, and never asked anything else.
        // The uplink stays open on purpose -- the worker is running and will reconnect on its
        // own schedule after an upgrade; closing it here would just make it redial.
        this.options.registry.incompatible(
          this.workerId,
          this.options.uplink.label,
          { gateway: error.details.client, worker: error.details.daemon },
          error.details.daemonVersion,
        );
        this.#logger.warn("Worker speaks no protocol version this gateway supports", {
          workerId: this.workerId,
          worker: error.details.daemon,
          gateway: error.details.client,
        });
        return;
      }
      this.#logger.warn("Worker uplink failed its first status call", {
        workerId: this.workerId,
        message: errorMessage(error),
      });
      await this.close();
      return;
    }

    if (client.role !== "admin") {
      // ADR 0005 §5 says the worker grants this session `admin` because it dialled the gateway
      // named in its own config. A worker that did not is either older than #117 or
      // misconfigured; either way the gateway can read nothing useful from it, and pretending
      // otherwise would produce a view full of `FORBIDDEN`s.
      this.#logger.error("Worker did not grant the gateway an admin session; closing the uplink", {
        workerId: this.workerId,
        role: client.role,
      });
      await this.close();
      return;
    }

    this.options.registry.connected(this.workerId, this.options.uplink.label, client.daemonVersion);
    // Subscribed before the first full refresh, not after: an event that fires while the
    // refresh is in flight then queues another one, instead of falling in a gap between the
    // two calls. It costs one extra `status.get` per connect, which is the cheapest call the
    // worker has.
    const subscription = client.subscribeEvents((push) => {
      this.#onWorkerEvent(push.event);
    });
    try {
      this.#unsubscribeEvents = await this.#withTimeout(subscription, "events.subscribe");
    } catch (error: unknown) {
      // H4: a `WorkerCallTimeoutError` here is not a refusal -- the worker was never asked and
      // said no, its answer just did not arrive within `WORKER_CALL_TIMEOUT_MS`. Logging it as
      // "refused" asserts something this code cannot know: the RPC may yet land, or may already
      // have subscribed the worker on its end with no unsubscribe handle this link ever
      // receives -- there is no way to unsubscribe that short of closing the whole link.
      // Distinguishing the two in the log is this method's job even though neither path retries
      // the subscription itself; a refused one is covered by the tick, a late one by below.
      if (error instanceof WorkerCallTimeoutError) {
        // #414: a worker still `starting` parks `events.subscribe` until its startup ends, and
        // sends `daemon.started` before that parked call subscribes, so nothing else tells this
        // link the worker is ready. The late answer is that signal: keep the handle it carries
        // and read the worker in full, instead of leaving the `starting` view until a lease,
        // device or install event or the tick. `refresh` drops itself on a closed or replaced
        // link, so the late answer needs no guard of its own.
        void subscription.then(
          (unsubscribe) => {
            this.#unsubscribeEvents = unsubscribe;
            void this.refresh();
          },
          () => undefined,
        );
        this.#logger.warn(
          "Worker did not answer an event subscription in time; reading it again when it answers",
          { workerId: this.workerId },
        );
      } else {
        this.#logger.warn("Worker refused an event subscription; falling back to the tick", {
          workerId: this.workerId,
          message: errorMessage(error),
        });
      }
    }
    await this.refresh({ includeCatalog: true });
  }

  /**
   * Rebuilds this worker's view. Concurrent calls coalesce into one in-flight refresh plus at
   * most one queued follow-up: a burst of worker events (a lease granted, its device leased,
   * its capacity changed) must not become a burst of round trips, but the *last* event in a
   * burst must still be reflected.
   *
   * Resolves once a refresh that started after this call has finished, so a caller that awaits
   * it reads a view at least as new as the moment it asked: a call that coalesces into the
   * queued follow-up waits for that follow-up, not for the one already in flight. Never rejects.
   */
  async refresh(options: RefreshOptions = {}): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#closed) return;
    if (this.#refreshing) {
      this.#queuedRefresh = queueRefresh(this.#queuedRefresh, options);
      return this.#queuedRefresh.done;
    }
    this.#refreshing = true;
    try {
      // No reset here on success: `#rebuildView` already reset `#consecutiveRefreshTimeouts` to
      // 0 the moment its `status.get` answered (C-1), which is a strictly earlier point than
      // this `await` ever returning -- reaching here without throwing is only possible once
      // that has already happened, which is what makes a second reset here dead code rather
      // than defense in depth.
      await this.#rebuildView(client, options.includeCatalog === true);
    } catch (error: unknown) {
      // A refresh that fails because the uplink died needs no handling here: `onClose` has
      // already marked the view disconnected. Anything else is worth a line, and the next tick
      // will try again.
      this.#logger.debug("Worker view refresh failed", {
        workerId: this.workerId,
        message: errorMessage(error),
      });
      // P1: a `WorkerCallTimeoutError` here is not "anything else" -- it is the one failure this
      // class already knows means "the socket is not answering", and it used to mean nothing
      // happened at all: `registry.refresh` was never reached, so `connection` stayed
      // `connected` and `lastSeenAt` stayed stale, forever, on a half-open uplink. After
      // `MAX_CONSECUTIVE_REFRESH_TIMEOUTS` in a row, close the link -- which routes through
      // `#handleClosed` into `registry.disconnected` -- rather than let it keep confidently
      // reporting a machine nothing can reach. `close()` is fire-and-forget here on purpose: it
      // flips `#closed` synchronously before its own first `await`, which is what the `finally`
      // block below needs to skip queuing another refresh behind a link that is on its way out.
      if (error instanceof WorkerCallTimeoutError) {
        this.#consecutiveRefreshTimeouts += 1;
        if (this.#consecutiveRefreshTimeouts >= MAX_CONSECUTIVE_REFRESH_TIMEOUTS) {
          this.#logger.warn("Worker stopped answering; closing its uplink", {
            workerId: this.workerId,
            consecutiveTimeouts: this.#consecutiveRefreshTimeouts,
          });
          void this.close();
        }
      }
    } finally {
      this.#refreshing = false;
      const queued = this.#queuedRefresh;
      this.#queuedRefresh = undefined;
      // A link on its way out refreshes nothing more; its waiters are released all the same.
      if (queued !== undefined) {
        if (this.#closed) queued.resolve();
        else void this.refresh(queued.options).then(queued.resolve);
      }
    }
  }

  /** The round trips one refresh makes, and what they become in the view. Split out of
   * `refresh` so that method is only the coalescing rule and this one is only the reads.
   * Bounded as one unit per call (D3): a worker that never answers one of these calls must not
   * latch `#refreshing` forever and freeze the view mid-flight while it still reports
   * `connected`. `status.get` is awaited on its own, ahead of the rest, and its arrival resets
   * `#consecutiveRefreshTimeouts` immediately (C-1): it is the one call `runDispatch` never
   * parks behind the worker's startup-readiness gate, so it answering is proof the transport is
   * alive even while the other three are genuinely, harmlessly queued behind a slow `converge`
   * -- application latency, not transport death, and P1's counter must not confuse the two. */
  async #rebuildView(client: SimlockAdminClient, includeCatalog: boolean): Promise<void> {
    const status = await this.#withTimeout(client.getStatus(), "status.get");
    this.#consecutiveRefreshTimeouts = 0;
    // A starting worker answers `status.get` with its health and host only, and everything else
    // it would say is unchecked. Nothing more is asked of it, and its view is built from those
    // two facts; the next refresh reads it in full once it answers `running`.
    if (status.daemon.health === "starting") {
      this.#refreshStarting(client, status);
      return;
    }
    // A starting answer dropped the view's catalog, and a refresh that does not read one would
    // leave the worker without it (and so not taking requests) until the next periodic read.
    const catalogKnown = this.options.registry.view(this.workerId)?.catalog !== undefined;
    await this.#refreshRunning(client, status, includeCatalog || !catalogKnown);
  }

  /** The rest of a refresh once `status.get` has answered, for a worker that is not starting:
   * its devices, and with `includeCatalog` its catalog and config, then one commit of the view. */
  async #refreshRunning(
    client: SimlockAdminClient,
    status: StatusGetOutput,
    includeCatalog: boolean,
  ): Promise<void> {
    const [devices, catalog, config] = await this.#withTimeout(
      Promise.all([
        client.list({ kind: "devices" }),
        includeCatalog ? client.getCatalog() : undefined,
        // Read on the same pass as the catalog: neither changes with a lease or a device, so
        // the per-event refresh stays at the two calls that do.
        includeCatalog ? client.getConfig() : undefined,
      ]),
      "view refresh",
    );
    // H2: the same asymmetry D1 fixed in `#handleClosed`, one write later. This link's own
    // `close()`/`#handleClosed` may have run while the round trips above were in flight -- a
    // reconnect that replaced this link with a newer one, or an explicit `stop()` -- and without
    // this re-check the write below would land after the successor's own, more recent refresh,
    // overwriting a fresh view with a stale one for up to `WORKER_CALL_TIMEOUT_MS`.
    if (this.#superseded()) return;
    // The leases come from `status.get` and the devices from the `list.get` after it, and a
    // worker keeps a device while a lease holds it, so a lease reported here names a device in
    // `devices` unless it ended in between. One `refresh` call commits both, so a lease is
    // never visible before its device. The view's fields come from the contract's one view
    // builder (ADR 0012 §1), the same one a worker answers `worker.list` about itself with; it
    // narrows the device records, so no `driverData` crosses the fleet into a gateway client's
    // `status.get`.
    this.options.registry.refresh(this.workerId, {
      ...workerViewFields({
        devices,
        status,
        ...(catalog === undefined ? {} : { catalog }),
        ...(config === undefined ? {} : { config }),
      }),
      grantedDevices: grantedDevices(devices),
      version: client.daemonVersion,
    });
  }

  /** Whether this link has been closed or replaced by a newer one for the same worker, so what
   * it read must not be written (H2). The one place that asks. */
  #superseded(): boolean {
    return this.#closed || (this.options.isCurrentLink?.() ?? true) === false;
  }

  /** A starting worker's view: its health and host, which `workerViewFields` builds from the
   * answer alone. Dropped for a link a reconnect or `stop()` has replaced, as `#rebuildView`'s own
   * write is (H2). */
  #refreshStarting(client: SimlockAdminClient, status: StatusGetOutput): void {
    if (this.#superseded()) return;
    this.options.registry.refresh(this.workerId, {
      ...workerViewFields({ status }),
      version: client.daemonVersion,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const unsubscribe = this.#unsubscribeEvents;
    this.#unsubscribeEvents = undefined;
    // Best-effort throughout: the connection may already be gone, which is the common case
    // here. The client and the connection are both closed -- closing the client is what tears
    // down its own bookkeeping, and closing the connection is what guarantees the socket is
    // gone even if the client never opened one (or failed on its way out).
    //
    // `unsubscribe` is a real `events.unsubscribe` round trip (D2): on a half-open socket it can
    // otherwise hang forever, since `.catch(() => undefined)` only swallows a *rejection* and
    // never fires on a promise that just never settles -- which is exactly what widened D1's
    // reconnect window from microseconds to minutes. Bounding it here is what lets `close()`
    // always reach `connection.close()`.
    await this.#withTimeout(unsubscribe?.() ?? Promise.resolve(), "events.unsubscribe").catch(
      () => undefined,
    );
    await this.#client?.close().catch(() => undefined);
    await this.options.uplink.connection.close().catch(() => undefined);
  }

  #handleClosed(): void {
    this.#closed = true;
    // ADR 0005 §6: the uplink is keyed by worker id, not by this link, so a worker that
    // reconnects while this link's socket is still (half-)open replaces it in the gateway's
    // bookkeeping well before the old socket is ever reported dead (D1). Marking the registry
    // disconnected here regardless would flip the *live* successor's view -- permanently,
    // since `refresh()` never touches `connection` -- so a late close only counts when this is
    // still the link the service considers current for its worker id.
    if (this.options.isCurrentLink?.() ?? true) this.options.registry.disconnected(this.workerId);
    this.options.onClosed?.(this.workerId);
  }

  /** Bounds one round trip to the worker (D2/D3): races `promise` against a timer and rejects
   * with `WorkerCallTimeoutError` if the timer wins. The timer is always cancelled once
   * `promise` settles, so a slow-but-eventually-successful call leaves nothing pending. */
  #withTimeout<Value>(promise: Promise<Value>, what: string): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const timer = this.options.clock.setTimer(WORKER_CALL_TIMEOUT_MS, () => {
        if (settled) return;
        settled = true;
        reject(new WorkerCallTimeoutError(what));
      });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.options.clock.cancel(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * ADR 0005 §22: a worker's business events are republished on the gateway's bus with
   * `workerId` added, so they land in its ring buffer and `simlock events --follow` against a
   * gateway shows the fleet. The name, the emitting module, the `id` and the `timestamp` travel
   * unchanged (ADR 0014 §2: one fact, one id, and the time it happened) -- the fact came
   * from that worker's reaper or its leasing module, and rewriting either would make the audit trail
   * lie about where it happened; `workerId` is what says which machine.
   *
   * Hardening: `envelope.event` is whatever string a worker's own `events.subscribe` push sends
   * -- a client of this same admin protocol, on a machine this gateway does not otherwise
   * control -- and `workerId` is merged in last, so it cannot be spoofed, but the *name* is
   * taken on faith. Refusing the names in `GATEWAY_OWN_EVENTS` (the six `worker.*` facts and
   * `request.granted`; `request.dispatched` is not in the set) keeps a worker from forging
   * `worker.drain-ended`, `worker.removed`, `request.granted`, etc. into the operator's audit trail -- facts this gateway itself is supposed to be the only
   * author of. Every other name still forwards unchanged, including ones this gateway's own
   * `EventMap` has never heard of (a newer worker's own vocabulary).
   */
  #onWorkerEvent(envelope: {
    readonly id: string;
    readonly timestamp: number;
    readonly event: string;
    readonly payload?: unknown;
    readonly module: string;
  }): void {
    if (GATEWAY_OWN_EVENTS.has(envelope.event)) {
      this.#logger.warn("Worker sent an event name reserved for the gateway itself; dropping it", {
        workerId: this.workerId,
        event: envelope.event,
      });
      return;
    }
    const payload = isRecord(envelope.payload)
      ? { ...envelope.payload, workerId: this.workerId }
      : { workerId: this.workerId };
    // The one cast in this file: a worker's event name is a string on the wire (see
    // `eventEnvelopeSchema`), and a *newer* worker may legitimately send a name this gateway's
    // `EventMap` has never heard of. Forwarding it is better than dropping it -- the envelope
    // is what `events.replay` returns, and a consumer that knows the name gets it either way.
    // ADR 0014 §2: the worker's `id` and `timestamp` travel with the fact (the wire layer bounded
    // both); only `seq` is this bus's own.
    this.options.eventBus.republish({
      event: envelope.event as EventName,
      id: envelope.id,
      module: envelope.module,
      payload: payload as never,
      timestamp: envelope.timestamp,
    });
    // ADR 0010 §7: an installed component is a new catalog entry, so that refresh re-reads it.
    if (changesCapacityOrLeases(envelope.event))
      void this.refresh({
        includeCatalog: (WORKER_VIEW_CATALOG_EVENTS as readonly string[]).includes(envelope.event),
      });
  }
}

/**
 * ADR 0005 §22 / `docs/internal/EVENTS.md`: the facts only a gateway itself ever emits -- six about
 * the workers connected to it, and (ADR 0021 §4) `request.granted`, the outcome of a fleet request.
 * Never forwarded from a worker's own event stream (see
 * `#onWorkerEvent`) -- a worker is a client of the same admin protocol, and nothing about
 * `events.subscribe` proves the name it pushes is genuinely its own.
 */
const GATEWAY_OWN_EVENTS: ReadonlySet<string> = new Set([
  "worker.connected",
  "worker.rejected",
  "worker.disconnected",
  "worker.removed",
  "worker.drain-started",
  "worker.drain-ended",
  "request.granted",
]);

/**
 * Which worker events make a view stale (ADR 0005 §7: "every worker event that changes capacity
 * or leases"). Matched by subject prefix rather than an explicit list of names: every event
 * about a lease or a device is, by construction, about something a view reports -- and a list
 * would silently miss the next one added to `EventMap`. The cost of being generous is one
 * coalesced round trip; the cost of missing one is a view that stays wrong until the next tick.
 *
 * ADR 0010 §7 adds the three install events by name: the view lists the worker's installs in
 * progress, and an install that starts or ends changes that list.
 */
function changesCapacityOrLeases(event: string): boolean {
  return event.startsWith("lease.") || event.startsWith("device.") || INSTALL_EVENTS.has(event);
}

const INSTALL_EVENTS: ReadonlySet<string> = new Set([
  "component.install-started",
  "component.installed",
  "component.install-failed",
]);

interface RefreshOptions {
  /** Also re-read the catalog and the config, as on connect and on the periodic tick. */
  readonly includeCatalog?: boolean;
}

interface QueuedRefresh {
  readonly options: RefreshOptions;
  readonly done: Promise<void>;
  readonly resolve: () => void;
}

/** One queued refresh stands for every request that queued; it reads the catalog when any of
 * them asked for it, and every one of them waits on the same `done`. */
function queueRefresh(queued: QueuedRefresh | undefined, next: RefreshOptions): QueuedRefresh {
  const options = {
    includeCatalog: queued?.options.includeCatalog === true || next.includeCatalog === true,
  };
  if (queued !== undefined) return { ...queued, options };
  let resolve!: () => void;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { done, options, resolve };
}

const defaultConnect: WorkerClientFactory = (connection, principal) =>
  connectSimlockAdmin({ connection, principal });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
