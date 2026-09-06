/**
 * One worker's uplink, from the gateway's side (ADR 0005 §5, §7, §22, §31).
 *
 * Over the uplink the gateway is the protocol *client*: this class drives the worker's own
 * dispatcher with the same typed admin client a supervisor process uses over a unix socket
 * (`connectSimlockAdmin`), which is the whole reason the fleet needs no second API. What it
 * does with that client is exactly what §7 prescribes -- `status.get`, `list.get`,
 * `catalog.get` and `events.subscribe` on connect, a refresh on every worker event that can
 * change capacity or leases, and a periodic refresh as a backstop -- plus §22's republishing of
 * those events onto the gateway's own bus with `workerId` added.
 *
 * One call §7 does not name is here too: `config.get`, read once per session for the worker's
 * `downloads.policy`. It is a routing input rather than decoration (§13: a request needing a
 * download is only eligible on a worker whose policy allows one), it never changes without a
 * worker restart -- which is a new session anyway -- and the uplink session is admin, so the
 * gateway may read it.
 */
import { z } from "zod";

import type { EventBus, EventName } from "../bus/index.js";
import { isSimlockError, statusDeviceSchema } from "../contract/index.js";
import type { SimlockAdminClient } from "../admin/index.js";
import { connectSimlockAdmin } from "../admin/index.js";
import type { AcceptedUplink, IpcConnection, Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import type { WorkerRegistry } from "./worker-registry.js";

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
  /** The principal the gateway announces at `hello`, namespaced by its own instance id, so a
   * worker's logs attribute what the gateway did to the gateway (ADR 0005 §27's shape). */
  readonly principal: string;
  readonly logger?: Logger;
  readonly connect?: WorkerClientFactory;
  /** Called once, when this uplink closes for any reason. */
  readonly onClosed?: (workerId: string) => void;
}

/** The device shape a view carries. Worker device records arrive through `list.get` as full
 * `DeviceRecord`s (admin's own view of a registry); narrowing them here is what keeps
 * `driverData` -- an opaque, driver-defined blob -- from crossing the fleet into a gateway
 * client's `status.get`. */
const viewDevicesSchema = z.array(statusDeviceSchema);

export class WorkerLink {
  readonly workerId: string;
  readonly #logger: Logger;
  #client: SimlockAdminClient | undefined;
  #unsubscribeEvents: (() => Promise<void>) | undefined;
  #closed = false;
  #refreshing = false;
  #refreshQueued = false;

  constructor(private readonly options: WorkerLinkOptions) {
    this.workerId = options.uplink.workerId;
    this.#logger = options.logger ?? new NoopLogger();
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
      client = await connect(this.options.uplink.connection, this.options.principal);
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
      // snapshot taken before the event subscription exists.
      await client.getStatus();
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
    try {
      this.#unsubscribeEvents = await client.subscribeEvents((push) => {
        this.#onWorkerEvent(push.event);
      });
    } catch (error: unknown) {
      this.#logger.warn("Worker refused an event subscription; falling back to the tick", {
        workerId: this.workerId,
        message: errorMessage(error),
      });
    }
    await this.refresh({ includeCatalog: true });
  }

  /**
   * Rebuilds this worker's view. Concurrent calls coalesce into one in-flight refresh plus at
   * most one queued follow-up: a burst of worker events (a lease granted, its device leased,
   * its capacity changed) must not become a burst of round trips, but the *last* event in a
   * burst must still be reflected.
   */
  async refresh(options: { readonly includeCatalog?: boolean } = {}): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#closed) return;
    if (this.#refreshing) {
      this.#refreshQueued = true;
      return;
    }
    this.#refreshing = true;
    try {
      const [status, devices, catalog, config] = await Promise.all([
        client.getStatus(),
        client.list({ kind: "devices" }),
        options.includeCatalog === true ? client.getCatalog() : undefined,
        // Read on the same pass as the catalog: both are session-lifetime facts, and pairing
        // them keeps the per-event refresh down to the two calls that actually go stale.
        options.includeCatalog === true ? client.getConfig() : undefined,
      ]);
      this.options.registry.refresh(this.workerId, {
        capacity: status.capacity,
        devices: viewDevicesSchema.parse(devices),
        health: status.health,
        leases: status.leases,
        queueDepth: status.queueDepth,
        version: client.daemonVersion,
        ...(catalog === undefined ? {} : { catalog: catalog.platforms }),
        ...(config === undefined ? {} : { downloads: { policy: config.downloads.policy } }),
      });
    } catch (error: unknown) {
      // A refresh that fails because the uplink died needs no handling here: `onClose` has
      // already marked the view disconnected. Anything else is worth a line, and the next tick
      // will try again.
      this.#logger.debug("Worker view refresh failed", {
        workerId: this.workerId,
        message: errorMessage(error),
      });
    } finally {
      this.#refreshing = false;
      if (this.#refreshQueued && !this.#closed) {
        this.#refreshQueued = false;
        void this.refresh();
      }
    }
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
    await unsubscribe?.().catch(() => undefined);
    await this.#client?.close().catch(() => undefined);
    await this.options.uplink.connection.close().catch(() => undefined);
  }

  #handleClosed(): void {
    this.#closed = true;
    this.options.registry.disconnected(this.workerId);
    this.options.onClosed?.(this.workerId);
  }

  /**
   * ADR 0005 §22: a worker's business events are republished on the gateway's bus with
   * `workerId` added, so they land in its ring buffer and `simlock events --follow` against a
   * gateway shows the fleet. The name and the emitting module travel unchanged -- the fact came
   * from that worker's reaper or lease engine, and rewriting either would make the audit trail
   * lie about where it happened; `workerId` is what says which machine.
   */
  #onWorkerEvent(envelope: {
    readonly event: string;
    readonly payload?: unknown;
    readonly module: string;
  }): void {
    const payload = isRecord(envelope.payload)
      ? { ...envelope.payload, workerId: this.workerId }
      : { workerId: this.workerId };
    // The one cast in this file: a worker's event name is a string on the wire (see
    // `eventEnvelopeSchema`), and a *newer* worker may legitimately send a name this gateway's
    // `EventMap` has never heard of. Forwarding it is better than dropping it -- the envelope
    // is what `events.replay` returns, and a consumer that knows the name gets it either way.
    this.options.eventBus.emit(envelope.event as EventName, payload as never, envelope.module);
    if (changesCapacityOrLeases(envelope.event)) void this.refresh();
  }
}

/**
 * Which worker events make a view stale (ADR 0005 §7: "every worker event that changes capacity
 * or leases"). Matched by subject prefix rather than an explicit list of names: every event
 * about a lease or a device is, by construction, about something a view reports -- and a list
 * would silently miss the next one added to `EventMap`. The cost of being generous is one
 * coalesced round trip; the cost of missing one is a view that stays wrong until the next tick.
 */
function changesCapacityOrLeases(event: string): boolean {
  return event.startsWith("lease.") || event.startsWith("device.");
}

const defaultConnect: WorkerClientFactory = (connection, principal) =>
  connectSimlockAdmin({ connection, principal });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
