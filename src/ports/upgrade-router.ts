// why: the one `upgrade` listener of an HTTP server: `/v1/uplink` goes to the uplink's own handler,
// `/v1/leases/{id}/<module>` to the app's lease socket resolution, and anything else gets a 404 and its
// socket destroyed. With `uplink-websocket.ts`, the only code that imports `ws`; the ports barrel does
// not re-export it, so the CLI and MCP server never load it.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { type Clock, SystemClock } from "./clock.js";
import type { LeaseSocket, LeaseSocketAccept } from "./lease-socket.js";
import { UPLINK_PATH } from "./uplink.js";

export type LeaseSocketOutcome =
  | { readonly response: Response }
  | { readonly accept: LeaseSocketAccept };

export interface UpgradeRouterOptions {
  readonly uplinks?: {
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  };
  readonly leaseSocket: (request: Request) => Promise<LeaseSocketOutcome>;
  readonly clock?: Clock;
}

export function respondAndDestroy(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const LEASE_SOCKET_PATH = /^\/v1\/leases\/[^/]+\/[^/]+$/;

// why: a ping that finds no pong since the previous one ends the socket, so a client that vanished
// without closing is noticed within one of these after the first.
const CLIENT_PING_INTERVAL_MS = 15_000;

// why: an input message is at most 64 KiB; this bound is the router's memory limit for one message,
// above it so a module can drop an oversized message and keep the socket.
const MAX_MESSAGE_BYTES = 1024 * 1024;

export function createUpgradeRouter(options: UpgradeRouterOptions): {
  readonly attach: (server: Server) => void;
} {
  const sockets = new WebSocketServer({ maxPayload: MAX_MESSAGE_BYTES, noServer: true });
  const clock = options.clock ?? new SystemClock();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path === UPLINK_PATH && options.uplinks !== undefined) {
      void options.uplinks.handleUpgrade(request, socket, head);
    } else if (LEASE_SOCKET_PATH.test(path)) {
      void leaseUpgrade(options, sockets, clock, request, socket, head);
    } else {
      respondAndDestroy(socket, 404, "Not Found");
    }
  };
  return { attach: (server) => server.on("upgrade", upgrade) };
}

async function leaseUpgrade(
  options: UpgradeRouterOptions,
  sockets: WebSocketServer,
  clock: Clock,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  // why: a client that resets while the module resolves would emit an `error` on a raw socket nothing listens to yet, and that ends the process; `ws` takes the socket's errors over once it upgrades.
  socket.on("error", () => undefined);
  let outcome: LeaseSocketOutcome;
  try {
    outcome = await options.leaseSocket(toRequest(request));
  } catch {
    respondAndDestroy(socket, 500, "Internal Server Error");
    return;
  }
  if ("response" in outcome) {
    await refuse(socket, outcome.response);
    return;
  }
  const { accept } = outcome;
  // why: `ws` answers a handshake it refuses (a bad version, a bad key) itself and never calls back, so what the module opened for this socket is released when the connection ends unaccepted.
  let upgraded = false;
  socket.once("close", () => {
    if (!upgraded) accept.abandon?.();
  });
  if (socket.destroyed) {
    accept.abandon?.();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (client) => {
    upgraded = true;
    accept(wrap(client, clock));
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

function wrap(client: WebSocket, clock: Clock): LeaseSocket {
  const closeListeners: (() => void)[] = [];
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
  client.on("error", () => undefined);
  client.once("close", () => {
    if (timer !== undefined) clock.cancel(timer);
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
