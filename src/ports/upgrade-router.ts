// why: the one `upgrade` listener of an HTTP server: `/v1/uplink` goes to the uplink's own handler,
// `/v1/leases/{id}/<module>` to the app's lease socket resolution, and anything else gets a 404 and its
// socket destroyed. It imports `ws` statically, as `uplink-websocket.ts` does; the ports barrel does
// not re-export it, so the CLI and MCP server never load it.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { type Clock, SystemClock } from "./clock.js";
import { subscribeListener } from "./ipc.js";
import type { LeaseSocket, LeaseSocketAccept } from "./lease-socket.js";
import type { SessionConnection, SessionOutcome } from "./session-socket.js";
import { UPLINK_PATH } from "./uplink.js";

export type LeaseSocketOutcome =
  | { readonly response: Response }
  | { readonly accept: LeaseSocketAccept };

export interface UpgradeRouterOptions {
  readonly uplinks?: {
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  };
  readonly leaseSocket: (request: Request) => Promise<LeaseSocketOutcome>;
  readonly session?: (request: Request) => Promise<SessionOutcome>;
  readonly clock?: Clock;
}

export function respondAndDestroy(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const SESSION_PATH = "/v1/session";

const LEASE_SOCKET_PATH = /^\/v1\/leases\/[^/]+\/[^/]+$/;

// why: a ping that finds no pong since the previous one ends the socket, so a client that vanished
// without closing is noticed within one of these after the first.
const CLIENT_PING_INTERVAL_MS = 15_000;

// why: an input message is at most 64 KiB; this bound is the router's memory limit for one message,
// above it so a module can drop an oversized message and keep the socket.
const MAX_MESSAGE_BYTES = 1024 * 1024;

// why: a session message is one protocol line, and a `device.exec` carries up to 8 Mi of stdin in
// one; this is the router's memory limit for one, past it `ws` closes the socket with 1009.
const MAX_SESSION_MESSAGE_BYTES = 32 * 1024 * 1024;

export function createUpgradeRouter(options: UpgradeRouterOptions): {
  readonly attach: (server: Server) => void;
} {
  const sockets = new WebSocketServer({ maxPayload: MAX_MESSAGE_BYTES, noServer: true });
  const sessionSockets = new WebSocketServer({
    maxPayload: MAX_SESSION_MESSAGE_BYTES,
    noServer: true,
  });
  const clock = options.clock ?? new SystemClock();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path === UPLINK_PATH && options.uplinks !== undefined) {
      void options.uplinks.handleUpgrade(request, socket, head);
    } else if (path === SESSION_PATH && options.session !== undefined) {
      const resolve = options.session;
      void upgradeSocket(resolve, sessionSockets, request, socket, head, (outcome, client) =>
        outcome.accept(wrapSession(client, clock, outcome.expiresAt)),
      );
    } else if (LEASE_SOCKET_PATH.test(path)) {
      void upgradeSocket(options.leaseSocket, sockets, request, socket, head, (outcome, client) =>
        outcome.accept(wrap(client, clock)),
      );
    } else {
      respondAndDestroy(socket, 404, "Not Found");
    }
  };
  return { attach: (server) => server.on("upgrade", upgrade) };
}

// why: the lease sockets and the session share the steps around the upgrade: resolve the request
// through the app, send a refusal as the HTTP answer, and release what the module opened when the
// handshake fails.
async function upgradeSocket<
  Outcome extends
    | { readonly accept: ((socket: never) => void) & { readonly abandon?: () => void } }
    | { readonly response: Response },
>(
  resolve: (request: Request) => Promise<Outcome>,
  sockets: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  open: (outcome: Extract<Outcome, { accept: unknown }>, client: WebSocket) => void,
): Promise<void> {
  // why: a client that resets while the module resolves would emit an `error` on a raw socket nothing listens to yet, and that ends the process; `ws` takes the socket's errors over once it upgrades.
  socket.on("error", () => undefined);
  let outcome: Outcome;
  try {
    outcome = await resolve(toRequest(request));
  } catch {
    respondAndDestroy(socket, 500, "Internal Server Error");
    return;
  }
  if ("response" in outcome) {
    await refuse(socket, outcome.response);
    return;
  }
  const accepted = outcome as Extract<Outcome, { accept: unknown }>;
  const { abandon } = accepted.accept;
  // why: `ws` answers a handshake it refuses (a bad version, a bad key) itself and never calls back, so what the module opened for this socket is released when the connection ends unaccepted.
  let upgraded = false;
  socket.once("close", () => {
    if (!upgraded) abandon?.();
  });
  if (socket.destroyed) {
    abandon?.();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => {
    upgraded = true;
    open(accepted, client);
  });
}

function toRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(`http://${request.headers.host ?? "simlock"}${request.url ?? "/"}`, {
    headers,
    method: request.method ?? "GET",
  });
}

async function refuse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.set("connection", "close");
  headers.set("content-length", String(body.length));
  let head = `HTTP/1.1 ${String(response.status)} ${response.statusText || "Refused"}\r\n`;
  for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
  socket.write(`${head}\r\n`);
  socket.write(body);
  socket.destroy();
}

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

// why: the lease sockets and the session share the ping: it ends the socket of a client that vanished without closing.
function keepAlive(client: WebSocket, clock: Clock): void {
  let awaitingPong = false;
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  const tick = (): void => {
    if (awaitingPong) {
      client.terminate();
      return;
    }
    awaitingPong = true;
    client.ping();
    timer = clock.setTimer(CLIENT_PING_INTERVAL_MS, tick);
  };
  timer = clock.setTimer(CLIENT_PING_INTERVAL_MS, tick);
  client.on("pong", () => {
    awaitingPong = false;
  });
  client.once("close", () => {
    if (timer !== undefined) clock.cancel(timer);
  });
}

function wrap(client: WebSocket, clock: Clock): LeaseSocket {
  const closeListeners: (() => void)[] = [];
  keepAlive(client, clock);
  client.on("error", () => undefined);
  client.once("close", () => {
    for (const listener of closeListeners) listener();
  });
  return {
    close: (code, reason) => client.close(code, reason),
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onMessage: (listener) => {
      client.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) listener(bytesOf(data));
      });
    },
    send: (data) => {
      if (client.readyState === client.OPEN) client.send(data, { binary: true });
    },
  };
}

// why: the session's adapter. The daemon reads a connection as chunks split on `\n`, so each text
// message gets its newline back; a `write` holding several lines goes out as one message per line.
function wrapSession(
  client: WebSocket,
  clock: Clock,
  expiresAt: number | undefined,
): SessionConnection {
  const dataListeners = new Set<(chunk: string) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let closed = false;
  keepAlive(client, clock);
  // why: ADR 0081 §2: a session opened by an identity with an expiry (a proxy JWT) ends then, as HTTP streams do.
  if (expiresAt !== undefined) {
    const expiry = clock.setTimer(Math.max(0, expiresAt - clock.now()), () =>
      client.close(4001, "identity expired"),
    );
    client.once("close", () => clock.cancel(expiry));
  }
  client.on("message", (data: RawData, isBinary: boolean) => {
    // why: once the socket is closing (revoked, expired, refused) a peer that has not answered the close yet is served no more, for the 30 s ws waits.
    if (client.readyState !== client.OPEN) return;
    // why: a session carries text lines only; a binary message closes the socket and runs nothing.
    if (isBinary) {
      client.close(1003, "binary message");
      return;
    }
    const chunk = `${bytesOf(data).toString()}\n`;
    for (const listener of dataListeners) listener(chunk);
  });
  client.on("error", (error: Error) => {
    for (const listener of errorListeners) listener(error);
  });
  client.once("close", () => {
    closed = true;
    for (const listener of closeListeners) listener();
  });
  return {
    get closed() {
      return closed;
    },
    close: async () => {
      client.close();
    },
    closeWith: (code, reason) => client.close(code, reason),
    onClose: (listener) => subscribeListener(closeListeners, listener),
    onData: (listener) => subscribeListener(dataListeners, listener),
    onError: (listener) => subscribeListener(errorListeners, listener),
    write: async (contents) => {
      for (const line of contents.split("\n")) {
        if (line === "" || client.readyState !== client.OPEN) continue;
        await new Promise<void>((done) => client.send(line, () => done()));
      }
    },
  };
}
