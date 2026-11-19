import type { EventBus, EventEnvelope } from "../bus/index.js";
import { PUSH_SCHEMAS, type ComponentProgress } from "../contract/index.js";
import type { LeaseProgress } from "../core/index.js";
import type { RequestId } from "../daemon-protocol/index.js";
import type { IpcConnection, Logger } from "../ports/index.js";
import { type Connection, parseOutput, writeFrame } from "./server-connection.js";

interface ConnectionPushesOptions {
  readonly connections: ReadonlySet<Connection>;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

export class ConnectionPushes {
  #eventSubscriptionSeq = 0;

  constructor(private readonly options: ConnectionPushesOptions) {}

  /** why: Connection-scoped: tears down any existing `events.subscribe` unconditionally (matches
   * the pre-dispatcher behaviour -- a second `subscribe` replaces the first), then, if asked,
   * wires a fresh one that pushes every bus event to this connection. Kept in `DaemonServer`
   * because event delivery is a push (ADR §2: pushes stay with the transport); the dispatcher's
   * `events.subscribe`/`events.unsubscribe` handlers do nothing but call this. */
  manageEventSubscription(connection: Connection, subscribe: boolean): string | undefined {
    connection.unsubscribeEvents?.();
    connection.unsubscribeEvents = undefined;
    connection.subscriptionId = undefined;
    if (!subscribe) return undefined;
    this.#eventSubscriptionSeq += 1;
    const subscriptionId = `sub_${this.#eventSubscriptionSeq}`;
    connection.subscriptionId = subscriptionId;
    connection.unsubscribeEvents = this.options.eventBus.subscribeAll((event) => {
      void this.#pushEvent(connection.socket, subscriptionId, event);
    });
    return subscriptionId;
  }

  relayHead(
    socket: IpcConnection,
    requestId: RequestId,
    status: number,
    headers: readonly (readonly [string, string])[],
  ): Promise<void> {
    return writeFrame(socket, {
      push: "relay-head",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS["relay-head"],
        { headers, requestId, status },
        "push:relay-head",
      ),
    });
  }

  async componentProgress(
    socket: IpcConnection,
    requestId: RequestId,
    progress: ComponentProgress,
    workerId: string | undefined,
  ): Promise<void> {
    return writeFrame(socket, {
      push: "component-progress",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS["component-progress"],
        { progress, requestId, ...(workerId === undefined ? {} : { workerId }) },
        "push:component-progress",
      ),
    });
  }

  /**
   * why: ADR 0005 §19a: `output` carries the originating request's frame id, exactly as `progress`
   * does, so a connection running more than one command routes each chunk to its own call.
   *
   * The returned promise is the backpressure signal, so it has to mean "this frame is out":
   * `IpcConnection.write` resolves on the socket's own write callback, which Node fires once
   * the chunk has been flushed rather than merely queued -- so awaiting it is waiting for the
   * drain a `write()` returning `false` would otherwise announce. `DaemonServer#execDevice` returns it to
   * the dispatcher, which stops reading the child until then.
   */
  async output(
    socket: IpcConnection,
    requestId: RequestId,
    stream: "stdout" | "stderr",
    chunk: string,
  ): Promise<void> {
    return writeFrame(socket, {
      push: "output",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS.output,
        { chunk, requestId, stream },
        "push:output",
      ),
    });
  }

  /**
   * why: ADR 0005 §19a: `started` carries the originating request's frame id, exactly as `output`
   * does. It is the one fact a gateway forwarding this command cannot infer for itself -- see
   * `startedPushSchema`'s own doc -- so the worker that knows it sends it.
   */
  async started(socket: IpcConnection, requestId: RequestId): Promise<void> {
    return writeFrame(socket, {
      push: "started",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS.started,
        { requestId },
        "push:started",
      ),
    });
  }

  /** why: ADR §8: `progress` carries the originating request's frame id, so a client with more than
   * one lease request in flight on the same connection can route each push to its own call. */
  async progress(
    socket: IpcConnection,
    requestId: RequestId,
    progress: LeaseProgress,
  ): Promise<void> {
    return writeFrame(socket, {
      push: "progress",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS.progress,
        { requestId, progress },
        "push:progress",
      ),
    });
  }

  async #pushEvent(
    socket: IpcConnection,
    subscriptionId: string,
    event: EventEnvelope,
  ): Promise<void> {
    await writeFrame(socket, {
      push: "event",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS.event,
        { subscriptionId, event },
        "push:event",
      ),
    });
  }

  /**
   * why: Pushes a lease-ended fact to every live connection whose principal owns `leaseId` (ADR
   * 0003 §8, kept by ADR 0004 §5: these are facts about the device, not a liveness channel).
   * Reacts to the existing post-commit lease.expired / lease.released facts (observer-only; no
   * transaction waits on this). `ownerId` comes from the event payload, not a registry lookup:
   * by the time this fires the lease has already been removed from the registry.
   */
  notifyLeaseLost(leaseId: string, deviceId: string, reason: string, ownerId: string): void {
    for (const connection of this.options.connections) {
      // why: Suppresses the push for exactly the connection that asked for this release itself
      // (see `selfInitiatedReleases`'s comment) -- every other connection sharing the owner
      // still gets pushed, which is the owner-routed fan-out this PR adds.
      if (connection.selfInitiatedReleases.delete(leaseId)) continue;
      if (connection.principal !== ownerId) continue;
      void this.#pushLeaseLost(connection.socket, { deviceId, leaseId, reason });
    }
  }

  async #pushLeaseLost(
    socket: IpcConnection,
    payload: { readonly deviceId: string; readonly leaseId: string; readonly reason: string },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "lease-lost",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS["lease-lost"],
        payload,
        "push:lease-lost",
      ),
    });
  }

  notifyDeviceUnhealthy(leaseId: string, deviceId: string, ownerId: string): void {
    for (const connection of this.options.connections) {
      if (connection.principal !== ownerId) continue;
      void this.#pushDeviceUnhealthy(connection.socket, { deviceId, leaseId, reason: "crashed" });
    }
  }

  async #pushDeviceUnhealthy(
    socket: IpcConnection,
    payload: { readonly deviceId: string; readonly leaseId: string; readonly reason: "crashed" },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "device-unhealthy",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS["device-unhealthy"],
        payload,
        "push:device-unhealthy",
      ),
    });
  }

  notifyDeviceRecovered(
    leaseId: string,
    deviceId: string,
    attempts: number,
    ownerId: string,
  ): void {
    for (const connection of this.options.connections) {
      if (connection.principal !== ownerId) continue;
      void this.#pushDeviceRecovered(connection.socket, { attempts, deviceId, leaseId });
    }
  }

  async #pushDeviceRecovered(
    socket: IpcConnection,
    payload: { readonly attempts: number; readonly deviceId: string; readonly leaseId: string },
  ): Promise<void> {
    await writeFrame(socket, {
      push: "device-recovered",
      payload: parseOutput(
        this.options.logger,
        PUSH_SCHEMAS["device-recovered"],
        payload,
        "push:device-recovered",
      ),
    });
  }
}
