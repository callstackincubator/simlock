/**
 * The WebSocket adapters behind the uplink port (`./uplink.ts`) -- the one file in the tree
 * that imports `ws`, kept out of the ports barrel so processes that never open an uplink (the
 * CLI, the MCP server) never load it.
 *
 * Why `ws` at all: Node 22 ships a WebSocket *client* and no server, and its client cannot set
 * request headers -- and the join token and the worker id both travel in headers at upgrade
 * time (ADR 0005 §4). Both halves therefore use `ws`, pinned to an exact version in
 * package.json.
 *
 * The gateway's half is deliberately `noServer: true`: the uplink lives on the gateway's
 * *existing* HTTP listener, upgraded on `/v1/uplink`, so the whole fleet still has exactly one
 * inbound port (ADR 0005 decision 1). Authentication happens at upgrade, before any WebSocket
 * exists -- a request without a recognized `worker`-role bearer token gets a plain `401` and
 * its socket destroyed, so an unauthenticated peer never reaches the daemon protocol.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { subscribeListener, type IpcConnection } from "./ipc.js";
import {
  resolveUplinkUrl,
  uplinkOutcome,
  uplinkTokenId,
  UPLINK_PATH,
  UplinkError,
  WORKER_ID_HEADER,
  WORKER_LABEL_HEADER,
  type UplinkConnector,
  type UplinkDialOptions,
  type UplinkHandlers,
  type UplinkListener,
  type UplinkListenerFactory,
} from "./uplink.js";

/**
 * Wraps one WebSocket as the `IpcConnection` the daemon protocol expects. Each protocol frame
 * is sent as its own text message; frames are already newline-terminated by `serializeFrame`
 * and every reader buffers by newline, so a message boundary that does not line up with a
 * frame boundary is harmless either way.
 */
class WebSocketUplinkConnection implements IpcConnection {
  readonly #socket: WebSocket;
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  /**
   * Frames that arrived before anything subscribed. A real socket buffers what is sent to it
   * until someone reads; `ws` does not -- it emits `message` events, and one emitted with no
   * listener attached is simply gone.
   *
   * That gap is not theoretical here, it is the normal case: over the uplink the *gateway*
   * speaks first (ADR 0005 §5), so its `hello` can be delivered in the same tick as the
   * WebSocket's `open` -- before the worker's `DaemonServer` has been handed the connection and
   * subscribed. Losing it deadlocks the link: the gateway waits forever for a reply to a frame
   * the worker never saw. Buffering until the first `onData` makes this adapter behave the way
   * every other `IpcConnection` in the tree already does.
   */
  readonly #pending: string[] = [];
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      // Binary frames are not part of this protocol. Ignoring one is the same treatment
      // `SimlockWire` gives a malformed line: a peer's bad frame is not this side's crash.
      if (isBinary) return;
      const chunk = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
      if (this.#dataListeners.size === 0) {
        this.#pending.push(chunk);
        return;
      }
      for (const listener of this.#dataListeners) listener(chunk);
    });
    socket.on("close", () => this.#markClosed());
    socket.on("error", (error: Error) => {
      for (const listener of this.#errorListeners) listener(error);
      this.#markClosed();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  onData(listener: (chunk: string) => void): () => void {
    const unsubscribe = subscribeListener(this.#dataListeners, listener);
    // Whatever arrived before anyone was listening is delivered to the first subscriber, in
    // order, before it sees anything new -- see `#pending`.
    if (this.#pending.length > 0) {
      const buffered = this.#pending.splice(0);
      for (const chunk of buffered) listener(chunk);
    }
    return unsubscribe;
  }

  onClose(listener: () => void): () => void {
    if (this.#closed) {
      listener();
      return () => {};
    }
    return subscribeListener(this.#closeListeners, listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return subscribeListener(this.#errorListeners, listener);
  }

  async write(contents: string): Promise<void> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    await new Promise<void>((resolve) => {
      // Resolving on the send callback (rather than fire-and-forget) keeps `write`'s contract
      // the same as the unix-socket adapter's: the caller may await a frame actually leaving.
      // A send error is not rethrown -- the `error` event above already reports it to every
      // listener, and a rejected `write` would tear down a caller that has nothing to do
      // about it.
      this.#socket.send(contents, () => resolve());
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#socket.close();
    this.#markClosed();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

/**
 * The gateway's half. `listen()` records the handlers; `attach(server)` wires the HTTP
 * server's `upgrade` event. The split exists because the HTTP server is created after this
 * factory (see `src/daemon/main.ts`), and a listener that silently did nothing until some
 * other call arrived would be a worse contract than one that names the call that wires it.
 */
export class WebSocketUplinkListenerFactory implements UplinkListenerFactory {
  readonly #server = new WebSocketServer({ noServer: true });
  #handlers: UplinkHandlers | undefined;
  #detach: (() => void) | undefined;

  async listen(handlers: UplinkHandlers): Promise<UplinkListener> {
    this.#handlers = handlers;
    return {
      close: async () => {
        this.#handlers = undefined;
        this.#detach?.();
        this.#detach = undefined;
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      },
    };
  }

  /** Wires this factory to a Node HTTP server's `upgrade` event. */
  attach(server: Server): void {
    const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.#handleUpgrade(request, socket, head);
    };
    server.on("upgrade", onUpgrade);
    this.#detach = () => {
      server.off("upgrade", onUpgrade);
    };
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const handlers = this.#handlers;
    if (handlers === undefined) {
      // Nothing is listening for uplinks (a daemon mid-shutdown): refuse rather than leave the
      // socket hanging half-upgraded.
      respondAndDestroy(socket, 404, "Not Found");
      return;
    }
    if (!isUplinkPath(request.url)) {
      // The gateway upgrades exactly one path. Anything else is a client that guessed, or an
      // HTTP route someone tried to upgrade; either way it is not an uplink.
      respondAndDestroy(socket, 404, "Not Found");
      return;
    }
    const rawWorkerId = headerValue(request, WORKER_ID_HEADER);
    if (rawWorkerId === undefined) {
      respondAndDestroy(socket, 400, "Bad Request");
      return;
    }
    // P3: truncated before anything else touches it, which bounds the *size* of a flood -- one
    // claimed id or label, up to Node's header budget (~16 KB), times the ring buffer's capacity
    // -- not the flood itself. Both fields below reach the gateway's event bus (`worker.rejected`
    // on the refusal path below, and a real `worker.connected` past authentication) *before* any
    // credential has been proven -- `GET /v1/uplink` needs no token to supply either -- and the
    // bus does no payload validation of its own. The other half of the harm this guards against
    // -- a loop of refused dials evicting every real fact an operator comes to `simlock events`
    // for, including the very `worker.connected`/`worker.disconnected` lines explaining the
    // outage they are debugging, since the buffer is bounded by count, not bytes -- is P-2's:
    // `GatewayService#recordRejection` coalesces repeated refusals into one event per window.
    const workerId = rawWorkerId.slice(0, MAX_CLAIMED_FIELD_LENGTH);
    // Decoded before authentication, not after: a dial that fails the credential check still
    // claimed this identity in its headers, and ADR 0005 §22's `worker.rejected` reports
    // whatever a refused peer claimed rather than nothing at all.
    const label = decodeLabel(headerValue(request, WORKER_LABEL_HEADER));
    const claimed = { workerId, ...(label === undefined ? {} : { label }) };
    let result: Awaited<ReturnType<UplinkHandlers["authenticate"]>>;
    try {
      result = await handlers.authenticate(bearerToken(request), claimed);
    } catch {
      // A token store that cannot be read is not an authenticated peer.
      result = "unauthenticated";
    }
    const outcome = uplinkOutcome(result);
    if (outcome !== "accept") {
      // 403 for a real token of the wrong role, 401 for one the gateway does not know
      // (ADR 0005 §25) -- the same distinction the HTTP frontend draws for a `worker` token on
      // an ordinary `/v1` route, in the opposite direction.
      if (outcome === "forbidden") respondAndDestroy(socket, 403, "Forbidden");
      else respondAndDestroy(socket, 401, "Unauthorized");
      return;
    }
    // C-2: the token record id that authorized this uplink, carried onto `AcceptedUplink` so a
    // later `token.revoke` of it can find and close this exact link (ADR 0005 §8).
    const tokenId = uplinkTokenId(result);
    this.#server.handleUpgrade(request, socket, head, (client) => {
      handlers.accept({
        connection: new WebSocketUplinkConnection(client),
        workerId,
        ...(label === undefined ? {} : { label }),
        ...(tokenId === undefined ? {} : { tokenId }),
      });
    });
  }
}

/** The worker's half: dials `gateway.url` with the join token and its instance id. */
export class WebSocketUplinkConnector implements UplinkConnector {
  async connect(options: UplinkDialOptions): Promise<IpcConnection> {
    // `options.url` is `gateway.url`, the gateway's base URL; the endpoint is this worker's to
    // derive (ADR 0005 §4), so an operator configures one URL and never an internal path.
    const socket = new WebSocket(resolveUplinkUrl(options.url), {
      headers: {
        authorization: `Bearer ${options.token}`,
        [WORKER_ID_HEADER]: options.workerId,
        ...(options.label === undefined
          ? {}
          : { [WORKER_LABEL_HEADER]: encodeURIComponent(options.label) }),
      },
    });
    // Wrapped *before* awaiting `open`, not after: the gateway speaks first over an uplink, and
    // its `hello` can be emitted in the same tick the socket opens. The wrapper's `message`
    // listener has to be attached by then, or that frame is lost and the link deadlocks (see
    // `WebSocketUplinkConnection#pending`).
    const connection = new WebSocketUplinkConnection(socket);
    try {
      await waitForOpen(socket);
    } catch (error: unknown) {
      socket.terminate();
      throw error;
    }
    return connection;
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(toUplinkError(error));
    };
    // `ws` emits this instead of `error` when the handshake gets an HTTP response -- which is
    // exactly what a refused join token looks like (401). Without it, a revoked token would be
    // indistinguishable from an unreachable gateway in the worker's log.
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      cleanup();
      const status = response.statusCode ?? 0;
      reject(
        new UplinkError(
          status === 401 || status === 403 ? "rejected" : "unknown",
          `The gateway refused the uplink with HTTP ${String(status)}`,
        ),
      );
    };
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpectedResponse);
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("unexpected-response", onUnexpectedResponse);
  });
}

function toUplinkError(error: unknown): UplinkError {
  if (error instanceof UplinkError) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const unreachable =
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ETIMEDOUT";
  return new UplinkError(
    unreachable ? "unreachable" : "unknown",
    error instanceof Error ? error.message : String(error),
    error,
  );
}

/** The upgrade request's path, compared without its query string. A request with no `url` at
 * all (which Node's typings allow) is not the uplink. */
function isUplinkPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const [path] = url.split("?");
  return path === UPLINK_PATH;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = headerValue(request, "authorization");
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const secret = header.slice("Bearer ".length).trim();
  return secret === "" ? undefined : secret;
}

/** P3: how long a claimed `workerId` or decoded label is allowed to be before either reaches
 * anything -- the event bus (`worker.rejected`, `worker.connected`), a view, or `workers.json`.
 * Comfortably longer than any real hostname or label an operator would set, far short of the
 * ~16 KB a raw header can carry. */
const MAX_CLAIMED_FIELD_LENGTH = 128;

/** Control characters (C0 and DEL), the one thing worth rejecting a label outright for rather
 * than just truncating -- a raw header value the gateway's own JSON logging already renders
 * safely (`writeResult` JSON-encodes; terminal escapes are not the concern here), but a
 * multi-line or unreadable "machine name" in `simlock worker list` and `simlock events` is not
 * something worth keeping even truncated. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the whole point.
const NON_PRINTABLE = /[\u0000-\u001f\u007f]/;

function decodeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded === "" || NON_PRINTABLE.test(decoded)) return undefined;
    // P3: truncated like `workerId` above, before it reaches the bus or a view -- see
    // `MAX_CLAIMED_FIELD_LENGTH`'s comment for why.
    return decoded.slice(0, MAX_CLAIMED_FIELD_LENGTH);
  } catch {
    // A label is cosmetic; a malformed encoding drops it rather than refusing the uplink.
    return undefined;
  }
}

function respondAndDestroy(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
