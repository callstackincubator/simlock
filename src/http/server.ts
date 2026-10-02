import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import type { Logger } from "../ports/index.js";

/**
 * Where `pnpm build` writes the console (ADR 0011 §2): `dist/ui`, beside this module's own
 * `dist/http`. Found from the module's URL, never from the working directory, so a daemon
 * started from anywhere serves the console it was built with.
 */
const BUILT_CONSOLE_ROOT = fileURLToPath(new URL("../ui", import.meta.url));

/** ADR 0011 §4: on every console response. `connect-src 'self'` is what keeps the browser
 * from sending anything to another host, whatever a dependency tries. */
export const CONSOLE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface HttpGatewayOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
  /** The built console's directory. Defaults to `dist/ui` beside this module; tests pass their own. */
  readonly consoleRoot?: string;
  /**
   * Called once, with the Node HTTP server, as soon as it exists (before it is listening).
   * ADR 0005 §4 puts the worker uplink on this same listener -- upgraded on `/v1/uplink` -- so
   * that the whole fleet has exactly one inbound port. The uplink adapter needs the server's
   * `upgrade` event to do that, and this is the only thing it needs; handing it the server
   * here keeps `HttpGateway` from growing any knowledge of WebSockets, uplinks, or workers.
   * Undefined on a worker, which upgrades nothing.
   */
  readonly onServerCreated?: (server: Server) => void;
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
 * ADR 0011 §3: the web console in front of `app.fetch`. `/v1` and everything under it goes to
 * the app untouched, so the API keeps its own auth, its own `404`s and its request log. Every
 * other path is the console's:
 *
 * - a `GET`/`HEAD` for a file in `root` serves that file;
 * - a `GET`/`HEAD` for a path with no file extension serves `index.html`, so a page URL
 *   survives a reload;
 * - anything else is `404`, so a missing asset is never answered with the page.
 *
 * Console files need no token -- they hold no data -- and never reach the app, so they are
 * not written to its request log: like `/v1/healthz`, they are anonymous, and logging them
 * would let anyone drive the log. When `root` holds no `index.html` (a TypeScript-only build),
 * this warns once and every console path answers `404`.
 */
export function withConsole(app: FetchApp, options: { root: string; logger: Logger }): FetchApp {
  const files = new Hono();
  if (existsSync(join(options.root, "index.html"))) {
    const page = serveStatic({ root: options.root, path: "index.html" });
    files.on(["GET", "HEAD"], "*", serveStatic({ root: options.root }), (c, next) =>
      hasFileExtension(c.req.path) ? next() : page(c, next),
    );
  } else {
    options.logger.warn("The web console is not built; console paths answer 404", {
      root: options.root,
    });
  }
  return {
    fetch: async (request, env, executionCtx) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/v1" || pathname.startsWith("/v1/")) {
        return app.fetch(request, env, executionCtx);
      }
      return withConsoleHeaders(await files.fetch(request), pathname);
    },
  };
}

/** Whether the path's last segment names a file (`/assets/index-3f2a.js`), not a page (`/workers`). */
function hasFileExtension(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).includes(".");
}

/**
 * ADR 0011 §4: set on the finished response, after the file is read. Only a file actually
 * found under `/assets/` is cached for good -- its name carries a content hash -- while
 * `index.html`, every other file and every `404` is revalidated, so a new release shows on the
 * next load.
 */
function withConsoleHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    response.ok && pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  );
  headers.set("Content-Security-Policy", CONSOLE_CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
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
  readonly #onServerCreated: ((server: Server) => void) | undefined;
  readonly #consoleRoot: string;
  #server: Server | undefined;

  constructor(app: FetchApp, options: HttpGatewayOptions) {
    this.#app = app;
    this.#host = options.host;
    this.#port = options.port;
    this.#logger = options.logger;
    this.#onServerCreated = options.onServerCreated;
    this.#consoleRoot = options.consoleRoot ?? BUILT_CONSOLE_ROOT;
  }

  /** Resolves once listening, with the actual bound port (matches the configured one in v1, since port 0 is never used here). */
  start(): Promise<{ readonly port: number }> {
    // ADR 0011 §3: the console is served whenever HTTP is, in both modes; no key turns it off.
    const site = withConsole(this.#app, { logger: this.#logger, root: this.#consoleRoot });
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = serve(
        { fetch: site.fetch, hostname: this.#host, port: this.#port },
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
      // Before `listening` fires deliberately: an upgrade cannot arrive until the server is
      // listening, and wiring it here means there is no window where a connection is accepted
      // with no `upgrade` handler attached.
      this.#onServerCreated?.(server);
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
