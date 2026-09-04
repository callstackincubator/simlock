import type { Server } from "node:http";
import type { Socket } from "node:net";

import { serve } from "@hono/node-server";

import type { Logger } from "../ports/index.js";

export interface HttpGatewayOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
}

/**
 * The one bit of `Hono` this file depends on -- deliberately structural (not `import
 * type { Hono } from "hono"`) so this class doesn't have to match `createHttpApp`'s
 * specific `Env` type parameter; `app.fetch` is exactly what `serve()` wants.
 */
export interface FetchApp {
  // `any` (not `unknown`) for `env`/`executionCtx` deliberately: Hono's own `fetch` types
  // them permissively per its `Env` type parameter, and this interface exists purely to
  // let any `Hono<...>` instance satisfy it regardless of that parameter -- `unknown`
  // here would make assignment fail on parameter contravariance instead.
  readonly fetch: (request: Request, env?: any, executionCtx?: any) => Response | Promise<Response>;
}

/**
 * The impure serve adapter -- the only file under `src/http` allowed to import
 * `@hono/node-server` (or any `node:http`); everything else stays a pure
 * `Request -> Response` function (see `app.ts`'s own comment). Wraps `serve()`/
 * `server.close()` behind `start`/`stop`.
 *
 * Tracks every accepted socket so `stop()` can force them closed: an SSE stream
 * (`GET /v1/lease-requests/:id/events`, `/v1/leases/:id/events`, `/v1/events/stream`)
 * never ends on its own from the server side, and `server.close()`'s callback only
 * fires once every open connection has ended -- without the destroy step below, a
 * single client that never disconnected would hang `daemon stop` forever.
 */
export class HttpGateway {
  readonly #app: FetchApp;
  readonly #host: string;
  readonly #port: number;
  readonly #logger: Logger;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  constructor(app: FetchApp, options: HttpGatewayOptions) {
    this.#app = app;
    this.#host = options.host;
    this.#port = options.port;
    this.#logger = options.logger;
  }

  /** Resolves once listening, with the actual bound port (matches the configured one in v1, since port 0 is never used here). */
  start(): Promise<{ readonly port: number }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = serve(
        { fetch: this.#app.fetch, hostname: this.#host, port: this.#port },
        (info) => {
          if (settled) return;
          settled = true;
          this.#logger.info("HTTP gateway listening", { host: this.#host, port: info.port });
          resolve({ port: info.port });
        },
      ) as Server;
      // Only matters before "listening" fires -- e.g. EADDRINUSE. A post-listen socket
      // error is a per-connection concern, not a `start()` failure.
      server.once("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      server.on("connection", (socket: Socket) => {
        this.#sockets.add(socket);
        socket.once("close", () => this.#sockets.delete(socket));
      });
      this.#server = server;
    });
  }

  /** Closes the listener and destroys any connection still open, in-flight SSE streams included. */
  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      // Destroyed right after asking for the graceful close, not before: an ordinary
      // request already in flight gets to finish (its socket isn't in `#sockets` as
      // "still open" from the server's perspective any differently than an SSE one,
      // but it settles fast enough that the destroy below rarely if ever races it,
      // and a request abandoned mid-response is no worse than the daemon stopping
      // under it any other way). An SSE stream has no natural end to wait for.
      for (const socket of this.#sockets) socket.destroy();
    });
    this.#logger.info("HTTP gateway stopped", { host: this.#host, port: this.#port });
  }
}
