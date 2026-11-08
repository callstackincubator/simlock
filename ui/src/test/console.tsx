import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { App } from "../app/app";
import { createApiClient, type Fetch } from "../data/api";
import { createPreferences } from "../data/preferences";
import { createSession } from "../data/session";
import { NOW } from "./fixtures";

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

export interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly etag?: string;
}

export type Handler = Answer | ((call: Call) => Answer | Promise<Answer>);

// why: a key is `"GET /v1/workers"` or just `"/v1/workers"` (a GET); a `*` stands for one path
// segment, so `"POST /v1/workers/*/drain"` answers every worker's drain.
export type Routes = Readonly<Record<string, Handler>>;

const STREAM = "/v1/events/stream";

// why: what a daemon with nothing on it answers, so a test names only the routes its page reads.
const EMPTY: Routes = {
  "/v1/baselines": { body: { baselines: [] } },
  "/v1/events": { body: { events: [] } },
  "/v1/inbox": { body: { items: [] } },
  "/v1/lease-requests": { body: { requests: [] } },
  "/v1/leases": { body: { leases: [] } },
  "/v1/tokens": { body: { tokens: [] } },
  "/v1/workers": { body: { workers: [] } },
};

export interface ConsoleOptions {
  readonly path?: string;
  readonly routes?: Routes;
  // why: the token the browser already holds; `null` is a visitor who must sign in.
  readonly token?: string | null;
  readonly mode?: "gateway" | "worker";
  readonly daemon?: Readonly<Record<string, unknown>>;
}

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const have = path.split("/");
  return want.length === have.length && want.every((part, i) => part === "*" || part === have[i]);
}

function find(routes: Routes, method: string, path: string): Handler | undefined {
  for (const [key, handler] of Object.entries(routes)) {
    const [first = "", second] = key.split(" ");
    const [keyMethod, pattern] = second === undefined ? ["GET", first] : [first, second];
    if (keyMethod === method && matches(pattern, path)) return handler;
  }
  return undefined;
}

function json(status: number, body: unknown, etag?: string): Response {
  return new Response(status === 304 || body === undefined ? null : JSON.stringify(body), {
    headers: {
      ...(etag === undefined ? {} : { ETag: etag }),
      "Content-Type": "application/json",
      Date: new Date(Date.now()).toUTCString(),
    },
    status,
  });
}

export function renderConsole(options: ConsoleOptions = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const routes: Routes = {
    ...EMPTY,
    "/v1/identity":
      options.token === null
        ? { body: { error: { code: "UNAUTHENTICATED", message: "Sign in" } }, status: 401 }
        : { body: { name: "operator" } },
    "/v1/status": {
      body: { daemon: { mode: options.mode ?? "gateway", version: "0.6.0", ...options.daemon } },
    },
    ...options.routes,
  };
  const calls: Call[] = [];
  const unanswered: string[] = [];
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];

  const fetch: Fetch = async (input, init) => {
    const url = new URL(input, "http://console.test");
    const method = init.method ?? "GET";
    if (url.pathname === STREAM) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          init.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              // why: the test already ended this stream.
            }
          });
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" }, status: 200 });
    }
    const call: Call = {
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      method,
      path: url.pathname,
      search: url.search,
    };
    calls.push(call);
    const handler = find(routes, method, url.pathname);
    if (handler === undefined) {
      unanswered.push(`${method} ${url.pathname}`);
      return json(404, { error: { code: "NOT_FOUND", message: "No route in this test" } });
    }
    const answer = typeof handler === "function" ? await handler(call) : handler;
    const headers = new Headers(init.headers);
    if (answer.etag !== undefined && headers.get("If-None-Match") === answer.etag) {
      return json(304, undefined, answer.etag);
    }
    return json(answer.status ?? 200, answer.body, answer.etag);
  };

  const session = createSession(() => window.sessionStorage, {
    fetch,
    now: () => Date.now(),
    reload: () => undefined,
  });
  if (options.token !== null) session.signIn(options.token ?? "tok_operator");
  const api = createApiClient({ fetch, onRefused: session.refused, token: session.token });
  const preferences = createPreferences(() => window.localStorage);
  session.start();
  window.history.pushState(null, "", options.path ?? "/");
  const user = userEvent.setup();
  const view = render(<App api={api} fetch={fetch} preferences={preferences} session={session} />);

  return {
    ...view,
    calls,
    callsTo: (method: string, path: string) =>
      calls.filter((call) => call.method === method && call.path === path),
    // why: the stream the console follows, so a test says what the daemon announces.
    events: {
      push(name: string, envelope: unknown) {
        const frame = `event: ${name}\ndata: ${JSON.stringify(envelope)}\n\n`;
        for (const stream of streams) stream.enqueue(encoder.encode(frame));
      },
      // why: the daemon going away: the stream ends, and the console opens a new one once the daemon
      // answers `/v1/healthz` again.
      drop() {
        for (const stream of streams.splice(0)) stream.close();
      },
    },
    session,
    unanswered,
    user,
  };
}
