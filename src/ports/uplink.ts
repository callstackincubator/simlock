/**
 * The worker uplink, as a port (architecture rule 9; ADR 0005 §33: "the uplink is a port
 * (`UplinkListenerFactory` on the gateway, `UplinkConnector` on the worker) with a WebSocket
 * adapter, so tests script it in memory").
 *
 * Two halves of one link:
 *
 * - **`UplinkConnector`** (worker side) dials `gateway.url` with the join token and the
 *   worker's instance id, and hands back a connection.
 * - **`UplinkListenerFactory`** (gateway side) accepts an authenticated uplink and hands the
 *   daemon that same abstract connection.
 *
 * What travels over it is the existing daemon protocol -- the newline-delimited JSON frames
 * `DaemonServer` and `SimlockWire` already speak -- which is why both halves traffic in
 * `IpcConnection` rather than a WebSocket type of their own. That is the point of ADR 0005's
 * decision 2 ("the uplink carries the existing contract"): the worker's own `DaemonServer`
 * accepts the uplink as one more connection, and the gateway drives it with the same typed
 * client a supervisor process uses over a unix socket. Neither end has a second vocabulary to
 * learn, and an operation added to the contract works over the uplink for free.
 *
 * The direction is deliberately inverted relative to what the names suggest: the *worker*
 * dials (so no worker needs an inbound port -- ADR 0005 decision 1), and over the resulting
 * connection the *gateway* is the protocol client (§5). So `UplinkConnector.connect` returns
 * the connection a `DaemonServer` will serve, and `UplinkListenerFactory.listen`'s `accept`
 * hands out the connection a client will drive.
 *
 * This module holds the port and its in-memory adapter only. The WebSocket adapters live in
 * `./uplink-websocket.ts`, which is the one file that imports `ws` -- kept out of the ports
 * barrel so the CLI and the MCP server, which never open an uplink, never load it.
 */
import type { IpcConnection } from "./ipc.js";

/** Header carrying the worker's instance identity (`instance.json`) at upgrade (ADR 0005 §3a,
 * §4). A header rather than a query parameter so the id stays out of proxy access logs. */
export const WORKER_ID_HEADER = "x-simlock-worker-id";
/** Header carrying `gateway.label`, URI-encoded (it is free text and may be non-ASCII). */
export const WORKER_LABEL_HEADER = "x-simlock-worker-label";
/**
 * The one route a `worker`-role join token may use (ADR 0005 §25), and the only path a gateway
 * upgrades an uplink on: `GET /v1/uplink`. A worker's `gateway.url` is the gateway's *base*
 * URL and this is derived from it -- see `resolveUplinkUrl` -- so an operator configures one
 * URL rather than remembering an endpoint.
 */
export const UPLINK_PATH = "/v1/uplink";

/**
 * Derives the uplink endpoint from `gateway.url`. Resolved against the base rather than
 * concatenated, so a gateway published under a sub-path by a reverse proxy
 * (`wss://ci.example/simlock/`) lands on `wss://ci.example/simlock/v1/uplink` rather than at
 * the host root. A base URL that already names the uplink path resolves to itself.
 */
export function resolveUplinkUrl(baseUrl: string): string {
  if (new URL(baseUrl).pathname.endsWith(UPLINK_PATH)) return baseUrl;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(UPLINK_PATH.slice(1), base).toString();
}

/** One accepted uplink: who opened it, and the frames it carries. */
export interface AcceptedUplink {
  /** The worker's instance id, from `WORKER_ID_HEADER`. */
  readonly workerId: string;
  /** `gateway.label`, when the worker sent one. Display only. */
  readonly label?: string;
  readonly connection: IpcConnection;
}

export interface UplinkListener {
  close(): Promise<void>;
}

/**
 * What the gateway makes of the credential presented at upgrade (ADR 0005 §4/§25). Three
 * outcomes, not two, because the difference is the difference between "who are you" and "you
 * are not allowed here":
 *
 * - `accept` -- a token the gateway holds with role `worker`.
 * - `unauthenticated` (`401`) -- no token, or one the gateway does not know. A revoked join
 *   token lands here, which is what closes an uplink after `simlock token revoke`.
 * - `forbidden` (`403`) -- a real token of the wrong role. An `agent` or `operator` token is
 *   valid elsewhere and carries no authority here, exactly as a `worker` token carries none on
 *   any other `/v1` route.
 */
export type UplinkAuthOutcome = "accept" | "unauthenticated" | "forbidden";

export interface UplinkHandlers {
  /**
   * Verifies the join token presented in the `Authorization: Bearer` header at upgrade time.
   * Anything but `accept` answers its HTTP status and destroys the socket without ever
   * completing the upgrade -- an unauthorized peer never reaches the daemon protocol at all.
   */
  authenticate(credential: string | undefined): Promise<UplinkAuthOutcome>;
  /** Called once per accepted uplink. */
  accept(uplink: AcceptedUplink): void;
}

export interface UplinkListenerFactory {
  listen(handlers: UplinkHandlers): Promise<UplinkListener>;
}

export interface UplinkDialOptions {
  /** `gateway.url`: the gateway's **base** URL (`ws://host:port`, or `wss://...`). The adapter
   * derives the uplink endpoint from it -- see `resolveUplinkUrl`. */
  readonly url: string;
  /** The join token, sent as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** This worker's instance id (`instance.json`). */
  readonly workerId: string;
  readonly label?: string;
}

export interface UplinkConnector {
  connect(options: UplinkDialOptions): Promise<IpcConnection>;
}

/**
 * Why a dial failure is its own error class: the worker's reconnect supervisor backs off on
 * *any* failure, but an operator reading the log needs to tell "the gateway is not up yet"
 * (`unreachable`) from "the gateway refused this token" (`rejected` -- a revoked or mistyped
 * join token, which retrying alone never fixes). ADR 0005 §4/§8: a revoked token closes the
 * uplink and the worker keeps retrying at the cap, which is right (an operator may mint a new
 * token at any moment) but should be obvious in the log rather than a silent loop.
 */
export type UplinkErrorCode = "unreachable" | "rejected" | "unknown";

export class UplinkError extends Error {
  constructor(
    readonly code: UplinkErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "UplinkError";
  }
}

/**
 * Deterministic in-process uplink, for tests that script a fleet without a socket (ADR 0005
 * §33/§35). `connect()` runs the same authentication the WebSocket adapter does, hands the
 * dialer one end and the listener's `accept` the other, and rejects with the same
 * `UplinkError` codes -- so a test that exercises a revoked token exercises the real branch.
 */
export class MemoryUplinkTransport implements UplinkListenerFactory, UplinkConnector {
  #handlers: UplinkHandlers | undefined;

  async listen(handlers: UplinkHandlers): Promise<UplinkListener> {
    if (this.#handlers !== undefined) {
      throw new UplinkError("unknown", "This memory uplink transport is already listening");
    }
    this.#handlers = handlers;
    return {
      close: async () => {
        this.#handlers = undefined;
      },
    };
  }

  async connect(options: UplinkDialOptions): Promise<IpcConnection> {
    const handlers = this.#handlers;
    if (handlers === undefined) {
      throw new UplinkError("unreachable", `No gateway is listening at ${options.url}`);
    }
    const outcome = await handlers.authenticate(options.token);
    if (outcome !== "accept") {
      throw new UplinkError("rejected", `The gateway rejected this join token: ${outcome}`);
    }
    const [workerEnd, gatewayEnd] = createConnectionPair();
    handlers.accept({
      connection: gatewayEnd,
      workerId: options.workerId,
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    return workerEnd;
  }
}

/**
 * Two `IpcConnection`s wired to each other: what one writes, the other's `onData` listeners
 * receive; closing either closes both. Used by `MemoryUplinkTransport`, and exported so a test
 * that needs a bare pair (a scripted worker on one end, a real `DaemonServer` on the other)
 * does not have to build one.
 */
export function createConnectionPair(): [IpcConnection, IpcConnection] {
  const left = new PairedConnection();
  const right = new PairedConnection();
  left.pair(right);
  right.pair(left);
  return [left, right];
}

class PairedConnection implements IpcConnection {
  readonly #closeListeners = new Set<() => void>();
  readonly #dataListeners = new Set<(chunk: string) => void>();
  /** Buffered until the first `onData`, exactly as the WebSocket adapter does and as a real
   * socket does: the peer may write before this end has been handed to whoever reads it. */
  readonly #pending: string[] = [];
  #peer: PairedConnection | undefined;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  pair(peer: PairedConnection): void {
    this.#peer = peer;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    if (this.#pending.length > 0) {
      const buffered = this.#pending.splice(0);
      for (const chunk of buffered) listener(chunk);
    }
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.#closed) {
      // A listener attached after the close would otherwise never fire, and consumers attach
      // `onClose` after construction -- an in-memory pair can close in between.
      listener();
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(): () => void {
    // An in-memory pair has no transport to fail; nothing ever emits here. Returning an inert
    // unsubscriber keeps the port's shape honest rather than pretending errors are possible.
    return () => {};
  }

  async write(contents: string): Promise<void> {
    const peer = this.#peer;
    if (this.#closed || peer === undefined || peer.#closed) return;
    if (peer.#dataListeners.size === 0) {
      peer.#pending.push(contents);
      return;
    }
    for (const listener of peer.#dataListeners) listener(contents);
  }

  async close(): Promise<void> {
    this.#close();
    const peer = this.#peer;
    if (peer !== undefined) peer.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}
