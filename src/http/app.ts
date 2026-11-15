import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { etag } from "hono/etag";

import type { Identity } from "../auth/index.js";
import { eventsPageQuery, OPERATIONS, usageWindow } from "../contract/index.js";
import { registerLeaseRequestRoutes } from "./app-lease-request-routes.js";
import { registerLeaseRoutes } from "./app-lease-routes.js";
import {
  emptyBodyAsNone,
  errorMessage,
  findOwnedLease,
  optionalQuery,
  parseDuration,
  statsRefusal,
} from "./app-helpers.js";
import type {
  Env,
  HttpAppDisposable,
  HttpGatewayDeps,
  HttpLeaseSocketOutcome,
  LeaseSocketCapture,
} from "./app-types.js";
import { requireAuth } from "./auth.js";
import {
  baselineListRoute,
  baselineRemoveRoute,
  baselineSaveRoute,
  componentListRoute,
  componentRemoveRoute,
  configRoute,
  eventsRoute,
  eventsStreamRoute,
  inboxRoute,
  tokenListRoute,
  updateRoute,
  workerDrainRoute,
  workerListRoute,
  workerRemoveRoute,
  workerUndrainRoute,
  workerUpdateRoute,
} from "./admin-declarations.js";
import { buildHttpSession } from "./dispatcher-session.js";
import { badRequest, errorResponse, mapError } from "./errors.js";
import {
  leaseFileDeleteRoute,
  leaseFileGetRoute,
  leaseFileListRoute,
  leaseFilePutRoute,
} from "./lease-declarations.js";
import { LeaseNoticeBuffer } from "./notices.js";
import {
  catalogRoute,
  deviceAddRoute,
  deviceRemoveRoute,
  devicesReplySchema,
  devicesRoute,
  healthzRoute,
  identityRoute,
  statsRoute,
  statusRoute,
} from "./route-declarations.js";
import { validationHook } from "./routes.js";
import { pipeSse } from "./sse.js";
import { LeaseRequestTracker } from "./tracker.js";

export type {
  HttpAppDisposable,
  HttpGatewayDeps,
  HttpLeaseFiles,
  HttpLeaseRoute,
  HttpLeaseSocketAccept,
  HttpLeaseSocketOutcome,
  HttpMount,
  HttpRegistryDevice,
  HttpRegistryReader,
} from "./app-types.js";

// fallow-ignore-next-line complexity -- route wiring for one focused resource surface; splitting it would scatter the shared closures (tracker, notices) across files for no clarity gain.
export function createHttpApp(deps: HttpGatewayDeps): OpenAPIHono<Env> & HttpAppDisposable {
  const app = new OpenAPIHono<Env>({ defaultHook: validationHook });
  const logger = deps.logger.child("http");
  const tracker = new LeaseRequestTracker({
    clock: deps.clock,
    dispatch: deps.dispatch,
    requests: deps.leaseRequests,
    answerDownloadsEarly: deps.answerDownloadsEarly,
  });
  const notices = new LeaseNoticeBuffer(deps.ownerRoutedFacts);

  const agentAuth = requireAuth(deps.auth);

  // why: The one error boundary. Hono's `compose` catches a thrown error at the layer that threw
  // it and hands it to `app.onError` right there -- it never propagates up through an outer
  // middleware's own `await next()` -- so this has to be `onError`, not a try/catch here.
  app.onError((error, c) => {
    const mapped = mapError(error);
    if (mapped.code === "INTERNAL") {
      logger.error("Unhandled request error", { message: errorMessage(error), path: c.req.path });
    }
    return errorResponse(c, error);
  });

  app.use("*", async (c, next) => {
    const start = deps.clock.now();
    await next();
    // why: The one unauthenticated route is also the one a tunnel/load-balancer polls: logging it
    // would let an anonymous flood drive the synchronous log sink from the event loop.
    if (c.req.path === "/v1/healthz") return;
    const identity = c.get("identity") as Identity | undefined;
    logger.info("request", {
      durationMs: deps.clock.now() - start,
      method: c.req.method,
      path: c.req.path,
      requesterId: identity?.principal,
      status: c.res.status,
    });
  });

  // why: Hono's `etag()` buffers the body to hash it, so it runs only under /v1 (a `*` step, so no `/v1/*` route is registered) on a JSON answer that is not a mount's, which it also gives `Cache-Control: no-store` unless it has one, so a CDN never stores it (a mount keeps the Cache-Control it set); a stream or a mount's own body is never read.
  const mountPrefixes = (deps.mounts ?? []).map((mount) => `/v1/${mount.prefix}`);
  const etagStep = etag();
  app.use("*", async (c, next) => {
    await next();
    const path = c.req.path;
    if (!path.startsWith("/v1/")) return;
    const mounted = mountPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (mounted || !c.res.headers.get("content-type")?.startsWith("application/json")) return;
    if (!c.res.headers.has("cache-control")) c.res.headers.set("Cache-Control", "no-store");
    await etagStep(c, () => Promise.resolve());
  });

  app.openapi(healthzRoute, (c) => c.json({ ok: true as const }, 200));

  app.openapi({ ...statusRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("status.get", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...catalogRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "catalog.get",
        OPERATIONS["catalog.get"].input.parse(c.req.valid("query")),
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  app.openapi({ ...componentListRoute, middleware: [agentAuth] }, async (c) => {
    const { platform } = c.req.valid("query");
    return c.json(
      await deps.dispatch(
        "component.list",
        platform === undefined ? {} : { platform },
        buildHttpSession(c.get("identity")),
      ),
      200,
    );
  });

  app.openapi({ ...componentRemoveRoute, middleware: [agentAuth] }, async (c) => {
    const { dryRun } = c.req.valid("query");
    const { platform, version } = c.req.valid("param");
    return c.json(
      await deps.dispatch(
        "component.remove",
        { platform, version, ...(dryRun === undefined ? {} : { dryRun: dryRun === "true" }) },
        buildHttpSession(c.get("identity")),
      ),
      200,
    );
  });

  app.openapi({ ...baselineListRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("baseline.list", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...baselineSaveRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "baseline.save",
        c.req.valid("json"),
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  app.openapi({ ...baselineRemoveRoute, middleware: [agentAuth] }, async (c) => {
    const { workerId } = c.req.valid("query");
    return c.json(
      await deps.dispatch(
        "baseline.remove",
        { name: c.req.valid("param").name, ...(workerId === undefined ? {} : { workerId }) },
        buildHttpSession(c.get("identity")),
      ),
      200,
    );
  });

  app.openapi({ ...deviceAddRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch("device.add", c.req.valid("json"), buildHttpSession(c.get("identity"))),
      200,
    ),
  );

  app.openapi({ ...deviceRemoveRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "device.remove",
        { id: c.req.valid("param").id },
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  registerLeaseRequestRoutes(app, { agentAuth, deps, notices, tracker });

  registerLeaseRoutes(app, { agentAuth, deps, notices, tracker });

  app.openapi({ ...tokenListRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("token.list", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...identityRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("identity.get", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...devicesRoute, middleware: [agentAuth] }, async (c) => {
    const devices = await deps.dispatch(
      "list.get",
      { kind: "devices" },
      buildHttpSession(c.get("identity")),
    );
    return c.json(devicesReplySchema.parse({ devices }), 200);
  });

  app.openapi({ ...workerListRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("worker.list", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...inboxRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("inbox.get", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...configRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("config.get", {}, buildHttpSession(c.get("identity"))), 200),
  );

  app.openapi({ ...updateRoute, middleware: [agentAuth, emptyBodyAsNone] }, async (c) => {
    const update = await deps.dispatch(
      "daemon.update",
      c.req.valid("json"),
      buildHttpSession(c.get("identity")),
    );
    return c.json(update, update.started ? 202 : 200);
  });

  app.openapi({ ...workerUpdateRoute, middleware: [agentAuth, emptyBodyAsNone] }, async (c) => {
    const update = await deps.dispatch(
      "worker.update",
      { ...c.req.valid("json"), workerId: c.req.valid("param").id },
      buildHttpSession(c.get("identity")),
    );
    return c.json(update, update.started ? 202 : 200);
  });

  app.openapi({ ...workerDrainRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.drain",
        { workerId: c.req.valid("param").id },
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  app.openapi({ ...workerUndrainRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.undrain",
        { workerId: c.req.valid("param").id },
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  app.openapi({ ...workerRemoveRoute, middleware: [agentAuth] }, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.remove",
        { workerId: c.req.valid("param").id },
        buildHttpSession(c.get("identity")),
      ),
      200,
    ),
  );

  app.openapi({ ...eventsRoute, middleware: [agentAuth] }, async (c) => {
    const { before, limit, since, worker } = c.req.valid("query");
    const answer = eventsPageQuery({ before, limit, since, worker });
    if ("refused" in answer) throw badRequest(answer.refused);
    const sinceTs = since === undefined ? undefined : deps.clock.now() - parseDuration(since);
    const events = await deps.dispatch(
      "events.replay",
      sinceTs === undefined ? answer.page : { ...answer.page, sinceTs },
      buildHttpSession(c.get("identity")),
    );
    return c.json({ events }, 200);
  });

  app.openapi({ ...statsRoute, middleware: [agentAuth] }, async (c) => {
    const query = c.req.valid("query");
    const asked = usageWindow(
      {
        ...optionalQuery(query.from, "from"),
        ...optionalQuery(query.since, "since"),
        ...optionalQuery(query.to, "to"),
      },
      deps.clock.now(),
    );
    if ("refused" in asked) throw badRequest(statsRefusal(asked.refused));
    return c.json(
      await deps.dispatch(
        "usage.get",
        query.ledger === undefined ? asked.window : { ...asked.window, includeLedger: true },
        buildHttpSession(c.get("identity")),
      ),
      200,
    );
  });

  app.openapi({ ...eventsStreamRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    let unsubscribeBus: (() => void) | undefined;
    const session = buildHttpSession(identity, {
      manageEventSubscription: (subscribe) => {
        if (!subscribe) {
          unsubscribeBus?.();
          unsubscribeBus = undefined;
          return undefined;
        }
        return "http-sse";
      },
    });
    // why: Role check + startup-readiness parking, same as every other dispatched operation; the
    // actual live feed is wired below via `subscribe()`'s own return, since HTTP has no
    // persistent connection for the dispatcher's push mechanism to write through (ADR §8: "the
    // HTTP notice buffer stays, because a polling client has no connection to push to" --
    // this route is the same story for the full event bus).
    await deps.dispatch("events.subscribe", {}, session);
    return pipeSse(
      c,
      deps.clock,
      {
        subscribe(send) {
          unsubscribeBus = deps.eventBus.subscribeAll((envelope) => {
            send({ data: envelope, event: envelope.event });
          });
          return () => {
            unsubscribeBus?.();
            unsubscribeBus = undefined;
          };
        },
      },
      identity.expiresAt,
    );
  });

  // why: the lease is resolved with `lease.get` (owner or operator) before the files handler runs, so it never checks an owner.
  const serveLeaseFiles = async (c: Context<Env>, id: string, name: string | undefined) => {
    const identity = c.get("identity");
    const lease = await findOwnedLease(deps, buildHttpSession(identity), id);
    return deps.leaseFiles.handle(
      c.req.raw,
      identity,
      {
        deviceId: lease.deviceId,
        id: lease.id,
        ...(lease.workerId === undefined ? {} : { workerId: lease.workerId }),
        ...(lease.workerLeaseId === undefined ? {} : { workerLeaseId: lease.workerLeaseId }),
      },
      name,
    );
  };
  for (const route of [leaseFilePutRoute, leaseFileGetRoute, leaseFileDeleteRoute]) {
    app.openapi({ ...route, middleware: [agentAuth] }, (c) => {
      const { id, name } = c.req.valid("param");
      return serveLeaseFiles(c as unknown as Context<Env>, id, name) as never;
    });
  }
  app.openapi(
    { ...leaseFileListRoute, middleware: [agentAuth] },
    (c) =>
      serveLeaseFiles(c as unknown as Context<Env>, c.req.valid("param").id, undefined) as never,
  );

  for (const mount of deps.mounts ?? []) {
    const handler = (c: Context<Env>) => mount.handle(c.req.raw, c.get("identity"));
    app.all(`/v1/${mount.prefix}`, agentAuth, handler);
    app.all(`/v1/${mount.prefix}/*`, agentAuth, handler);
  }

  for (const route of deps.leaseRoutes ?? []) {
    app.all(`/v1/leases/:id/${route.name}`, agentAuth, async (c) => {
      const identity = c.get("identity");
      const lease = await findOwnedLease(deps, buildHttpSession(identity), c.req.param("id"));
      const resolved = {
        deviceId: lease.deviceId,
        id: lease.id,
        ...(lease.workerId === undefined ? {} : { workerId: lease.workerId }),
        ...(lease.workerLeaseId === undefined ? {} : { workerLeaseId: lease.workerLeaseId }),
      };
      const capture = (c.env as { leaseSocket?: LeaseSocketCapture } | undefined)?.leaseSocket;
      if (capture === undefined) return route.handle(c.req.raw, identity, resolved);
      if (route.socket === undefined) return c.notFound();
      const opened = await route.socket.open(c.req.raw, identity, resolved);
      if (typeof opened !== "function") return opened;
      capture.accept = opened;
      return new Response(null, { status: 204 });
    });
  }

  // why: `notices` holds a subscription for the app's lifetime -- exposed here rather than left to
  // leak, so a caller composing this app into a longer-lived process (the daemon) can
  // unsubscribe it on shutdown.
  return Object.assign(app, {
    dispose: () => {
      notices.dispose();
    },
    leaseSocket: async (request: Request): Promise<HttpLeaseSocketOutcome> => {
      const capture: LeaseSocketCapture = {};
      const response = await app.fetch(request, { leaseSocket: capture });
      return capture.accept === undefined ? { response } : { accept: capture.accept };
    },
  });
}
