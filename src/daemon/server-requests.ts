import { type DriverRejection, NoDriverError, UnknownPassthroughToolError } from "../core/index.js";
import { type IpcConnection, type Logger } from "../ports/index.js";
import { type RequestFrame, type RequestId } from "../daemon-protocol/index.js";
import {
  leaseRelease,
  leaseReleaseRun,
  type OperationName,
  relayChannelSchema,
} from "../contract/index.js";
import { type LinkChannel } from "../link/index.js";
import { type ContractDispatcher, type DispatchSession } from "./dispatcher.js";
import { type Connection, errorMessage } from "./server-connection.js";
import { parseInput, ProtocolError } from "./server-hello.js";
import { ConnectionPushes } from "./server-pushes.js";

// why: Operations the socket hands to the dispatcher unchanged, with the connection's session.
// `driver.passthrough` is resolution only: the daemon never runs the command. Spawning it here
// would attach a user's interactive `adb shell` to the daemon's stdio, and the CLI is the process
// that actually has a terminal. ADR 0005 §23: the `worker.*` operations are listed like any
// other, and what a *given* daemon answers is the dispatcher's business, not the transport's --
// a worker's dispatcher answers `worker.list` about itself and refuses the rest with
// `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012).
const PASSTHROUGH_OPERATIONS: ReadonlySet<OperationName> = new Set<OperationName>([
  "lease.renew",
  "lease.cancel",
  "lease.get",
  "lease.list",
  "status.get",
  "list.get",
  "catalog.get",
  "cleanup.run",
  "doctor.run",
  "nuke.run",
  "warm.forget",
  "baseline.list",
  "baseline.remove",
  "baseline.save",
  "events.replay",
  "usage.get",
  "inbox.get",
  "events.subscribe",
  "events.unsubscribe",
  "driver.passthrough",
  "device.rotate",
  "relay.cancel",
  "config.get",
  "identity.get",
  "token.create",
  "token.list",
  "token.revoke",
  "worker.list",
  "worker.drain",
  "worker.undrain",
  "worker.remove",
  "worker.update",
  "alerts.test",
  "component.list",
  "component.remove",
  "device.add",
  "device.remove",
]);

interface ConnectionRequestsOptions {
  readonly dispatcher: ContractDispatcher;
  readonly pushes: ConnectionPushes;
  readonly logger: Logger;
  readonly driverRejections: readonly DriverRejection[];
  readonly leaseSnapshot: () => readonly {
    readonly id: string;
    readonly ownerId: string;
    readonly runId?: string | undefined;
  }[];
}

export class ConnectionRequests {
  constructor(private readonly options: ConnectionRequestsOptions) {}

  /**
   * why: A `NO_DRIVER` for a platform whose driver refused to start says nothing on its own:
   * it reads identically to "this host has no Xcode". Safety rule 9 promises Simlock
   * reports *why* a platform is missing, so the refusal's own one-liner travels with the
   * error on both paths a user meets it: leasing, and the `simlock simctl` / `simlock adb`
   * wrapper, whose bare "No driver provides a adb passthrough" reads as a missing SDK and
   * sends the operator off to install one instead of at the port conflict that caused it.
   */
  describeError(error: unknown): string {
    const message = errorMessage(error);
    const rejection = this.#rejectionFor(error);
    return rejection === undefined ? message : `${message} (${rejection.summary})`;
  }

  #rejectionFor(error: unknown): DriverRejection | undefined {
    const rejections = this.options.driverRejections;
    if (error instanceof NoDriverError) {
      return rejections.find((candidate) => candidate.platform === error.platform);
    }
    if (error instanceof UnknownPassthroughToolError) {
      return rejections.find(
        (candidate) => candidate.passthroughTools?.includes(error.tool) === true,
      );
    }
    return undefined;
  }

  // fallow-ignore-next-line complexity -- one case per request type; the arms that need a connection's own wiring are cases, the rest sit in `PASSTHROUGH_OPERATIONS`.
  async handle(
    connection: Connection,
    frame: RequestFrame,
    relayChannel: LinkChannel | undefined,
  ): Promise<unknown> {
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.id, frame.payload);
      case "lease.release": {
        const input = parseInput(leaseRelease.input, frame.payload);
        connection.selfInitiatedReleases.add(input.leaseId);
        try {
          return await this.options.dispatcher.dispatch(
            "lease.release",
            frame.payload,
            this.#session(connection),
          );
        } finally {
          connection.selfInitiatedReleases.delete(input.leaseId);
        }
      }
      case "lease.release-all": {
        // why: Every lease this principal owns is about to end, and this connection asked for it,
        // so suppress the self-push for each. Read from the registry rather than from
        // per-connection state, which no longer exists (ADR 0004 §3).
        //
        // The snapshot can skew either way against what the dispatched call actually
        // releases, and both ways are acceptable: a lease that expires inside the window is
        // suppressed here even though its `lease-lost` was the daemon's own doing (the caller
        // asked for that lease to end and is about to be told every lease of theirs is gone),
        // and one granted inside the window is not suppressed, so its holder gets the push it
        // would have got for any other force-release. Neither can suppress a push for a lease
        // this principal does not own, which is the property that matters.
        // #118: a gateway has no `#engine`, so it falls back to `options.leaseSnapshot` (its
        // fleet lease index) -- see that option's own doc comment.
        const releasing = this.options
          .leaseSnapshot()
          .filter((lease) => connection.role === "admin" || lease.ownerId === connection.principal)
          .map((lease) => lease.id);
        for (const leaseId of releasing) connection.selfInitiatedReleases.add(leaseId);
        try {
          return await this.options.dispatcher.dispatch(
            "lease.release-all",
            frame.payload ?? {},
            this.#session(connection),
          );
        } finally {
          for (const leaseId of releasing) connection.selfInitiatedReleases.delete(leaseId);
        }
      }
      case "lease.release-run": {
        const input = parseInput(leaseReleaseRun.input, frame.payload);
        // why: the leases of this run the caller owns (any owner's for an admin) are about to end at its own request, so its connection is not told they were lost.
        const releasing = this.options
          .leaseSnapshot()
          .filter(
            (lease) =>
              lease.runId === input.runId &&
              (connection.role === "admin" || lease.ownerId === connection.principal),
          )
          .map((lease) => lease.id);
        for (const leaseId of releasing) connection.selfInitiatedReleases.add(leaseId);
        try {
          return await this.options.dispatcher.dispatch(
            "lease.release-run",
            frame.payload,
            this.#session(connection),
          );
        } finally {
          for (const leaseId of releasing) connection.selfInitiatedReleases.delete(leaseId);
        }
      }
      case "device.exec":
        // why: Unlike `driver.passthrough` (in `PASSTHROUGH_OPERATIONS`), this one runs the command here -- so it needs the
        // per-call push wiring `lease.request` needs, and gets it the same way.
        return this.#execDevice(connection, frame.id, frame.payload);
      case "relay.request":
        return this.#relayRequest(connection, frame.id, frame.payload, relayChannel);
      case "component.install":
        return this.#installComponent(connection, frame.id, "component.install", frame.payload);
      case "worker.install-component":
        return this.#installComponent(
          connection,
          frame.id,
          "worker.install-component",
          frame.payload,
        );
      case "daemon.update":
        return this.options.dispatcher.dispatch(
          "daemon.update",
          frame.payload,
          this.#session(connection),
        );
      // why: "daemon.stop" is deliberately absent from this switch and from `PASSTHROUGH_OPERATIONS`: `#dispatchLine` intercepts it
      // itself, ahead of the protocol-mismatch and `#stopping` gates (ADR §6's frozen exception,
      // scoped to protocol version only -- still gated on a completed handshake and the `admin`
      // role there), so it never reaches `ConnectionRequests.handle`.
      default:
        if ((PASSTHROUGH_OPERATIONS as ReadonlySet<string>).has(frame.type)) {
          return this.options.dispatcher.dispatch(
            frame.type as OperationName,
            frame.payload,
            this.#session(connection),
          );
        }
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }
  #session(connection: Connection): DispatchSession {
    return {
      isGatewayUplink: connection.isGatewayUplink,
      manageEventSubscription: (subscribe) =>
        this.options.pushes.manageEventSubscription(connection, subscribe),
      principal: connection.principal,
      relays: connection.relays,
      role: connection.role,
      ...(connection.session === undefined
        ? { via: connection.isGatewayUplink === true ? ("uplink" as const) : ("socket" as const) }
        : {
            name: connection.session.name,
            via: connection.session.via,
            ...(connection.session.signOutUrl === undefined
              ? {}
              : { signOutUrl: connection.session.signOutUrl }),
          }),
    };
  }

  /**
   * why: The progress-delivery wiring ADR 0003 §2 keeps in `DaemonServer` ("DaemonServer keeps
   * framing, connection lifecycle, and pushes; it loses the request switch"). The actual lease
   * acquisition is `Dispatcher`'s `lease.request` handler; this method's job is what is left
   * around that call that depends on *this connection* rather than on the operation itself,
   * which since ADR 0004 is progress routing and nothing else -- a granted lease is not
   * attached to the connection that asked for it in any way.
   */
  async #requestLease(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
  ): Promise<unknown> {
    let progressSocket: IpcConnection | undefined = connection.socket;
    const disposeProgress = () => {
      progressSocket = undefined;
    };
    connection.progressDisposers.add(disposeProgress);
    // why: A connection close only silences this call's pushes (`disposeProgress`): the request
    // itself keeps waiting, and a client that reconnects repeats it to get its answer.
    let grant;
    try {
      grant = await this.options.dispatcher.dispatch("lease.request", value ?? {}, {
        ...this.#session(connection),
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            // why: Progress is advisory: one that does not fit the push contract (a `downloading`
            // component the driver named past the contract's bound) or a socket that went away
            // is dropped, and the request carries on to its answer.
            void this.options.pushes.progress(progressSocket, requestId, progress).catch(() => {
              this.options.logger.warn("A lease progress push was not sent", {
                stage: progress.stage,
              });
            });
          }
        },
      });
    } finally {
      connection.progressDisposers.delete(disposeProgress);
      disposeProgress();
    }
    // why: A grant that lands after its requester's connection died (or during a stop) is left
    // standing on purpose: ADR 0004 §3 -- connection close means nothing to a lease, so the
    // client that reconnects can renew it, and if none does it expires at its deadline like
    // any other.
    return grant;
  }

  /**
   * why: ADR 0005 §19a's output relay, and the exact counterpart of `#requestLease` above: the
   * operation itself is the dispatcher's `device.exec` handler; what lives here is the part
   * that depends on *this connection* -- turning each chunk into an `output` push carrying this
   * call's frame id, and stopping the moment the socket goes away.
   *
   * The command keeps running after a disconnect rather than being killed with it. That is the
   * same answer ADR 0004 §3 gives for leases (a dead connection is not a dead lease) and the
   * only safe one here: a half-applied `simctl install` interrupted because a client's tunnel
   * blipped is worse than one that finishes with nobody listening, and the daemon has no way to
   * know which half a kill would land in. Its exit code is simply lost with the connection, and
   * `exec.timeoutMs` still bounds how long it can run.
   */
  async #execDevice(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
  ): Promise<unknown> {
    let outputSocket: IpcConnection | undefined = connection.socket;
    const disposeOutput = () => {
      outputSocket = undefined;
    };
    connection.progressDisposers.add(disposeOutput);
    try {
      return await this.options.dispatcher.dispatch("device.exec", value ?? {}, {
        ...this.#session(connection),
        // why: Returned rather than fired and forgotten, which is what applies backpressure: the
        // dispatcher hands this promise to the process runner, which stops reading the child
        // until the frame has actually been written (ADR 0005 §19e -- "streamed, never
        // buffered" is only true end to end if a client that does not read slows the command
        // down instead of filling this process). A write that fails on a socket which died
        // between the check and the write (EPIPE) resolves rather than rejecting: the chunk is
        // lost with the connection, the command carries on, and a rejection here would both
        // wedge the child and, unhandled, take the daemon down over a client that hung up.
        onOutput: async (stream, chunk) => {
          if (outputSocket === undefined) return;
          await this.options.pushes
            .output(outputSocket, requestId, stream, chunk)
            .catch(() => undefined);
        },
        // why: ADR 0005 §19a: the process now exists. Fired and forgotten rather than awaited --
        // unlike `onOutput` this carries no backpressure meaning, and the dispatcher calls it
        // synchronously between the spawn and the first chunk. Every peer that negotiates
        // protocol 5 understands the frame (§31), so this is not a signal anyone opts out of.
        onStarted: () => {
          if (outputSocket === undefined) return;
          void this.options.pushes.started(outputSocket, requestId).catch(() => undefined);
        },
      });
    } finally {
      connection.progressDisposers.delete(disposeOutput);
      disposeOutput();
    }
  }

  #relayRequest(
    connection: Connection,
    requestId: RequestId,
    value: unknown,
    relayChannel: LinkChannel | undefined,
  ): Promise<unknown> {
    return this.options.dispatcher.dispatch("relay.request", value, {
      ...this.#session(connection),
      ...(relayChannel === undefined ? {} : { relayChannel }),
      onRelayHead: (status, headers) =>
        this.options.pushes.relayHead(connection.socket, requestId, status, headers),
    });
  }

  /**
   * why: ADR 0010 §6: the counterpart of `#requestLease` for an install. Each progress update becomes
   * a `component-progress` push carrying this call's frame id. A closed connection only
   * silences the pushes (`writeFrame` writes nothing to a closed socket, and a write that fails
   * is dropped): the install carries on for every call joined to it, and a client that
   * reconnects repeats the request to join it again.
   *
   * A gateway's `worker.install-component` takes the same path: its progress names the worker
   * it came from, and the push carries that `workerId` (ADR 0010 §7). A worker's dispatcher
   * refuses it with `UNSUPPORTED_IN_WORKER_MODE` (ADR 0012 §2).
   */
  #installComponent(
    connection: Connection,
    requestId: RequestId,
    operation: "component.install" | "worker.install-component",
    value: unknown,
  ): Promise<unknown> {
    return this.options.dispatcher.dispatch(operation, value ?? {}, {
      ...this.#session(connection),
      onComponentProgress: (progress, workerId) => {
        void this.options.pushes
          .componentProgress(connection.socket, requestId, progress, workerId)
          .catch(() => undefined);
      },
    });
  }
}

// why: `channel` is wire input, so its shape is checked before it names a channel; a name that fails, or one the link never saw, accepts nothing and the call fails `BAD_REQUEST` later.
export function acceptRelayChannel(
  connection: Connection,
  frame: RequestFrame,
): LinkChannel | undefined {
  if (frame.type !== "relay.request" || connection.link === undefined) return undefined;
  const payload: unknown = frame.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const name = relayChannelSchema.safeParse((payload as { channel?: unknown }).channel);
  if (!name.success) return undefined;
  try {
    return connection.link.acceptChannel(name.data);
  } catch {
    return undefined;
  }
}
