import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { etag } from "hono/etag";
import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import {
  type ComponentProgress,
  eventsPageQuery,
  OPERATIONS,
  parseDurationMs,
  usageWindow,
  type UsageWindowRefusal,
} from "../contract/index.js";
import type { Config, DeviceRecord } from "../core/index.js";
import type { OwnerRoutedFacts } from "../daemon/owner-routed-facts.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { type AuthEnv, requireAuth } from "./auth.js";
import { buildHttpSession, type HttpDispatch } from "./dispatcher-session.js";
import {
  componentInstallRoute,
  componentListRoute,
  componentRemoveRoute,
  eventsRoute,
  eventsStreamRoute,
  tokenListRoute,
  updateRoute,
  workerDrainRoute,
  workerListRoute,
  workerRemoveRoute,
  workerUndrainRoute,
  workerUpdateRoute,
} from "./admin-declarations.js";
import {
  badRequest,
  errorResponse,
  forbidden,
  mapError,
  requestNotCancellable,
  unknownLease,
  unknownRequest,
} from "./errors.js";
import {
  type leaseRequestBodySchema,
  leaseEventsRoute,
  leaseExecRoute,
  leaseGetRoute,
  leaseListRoute,
  leaseReleaseRoute,
  leaseRenewRoute,
  leaseRequestCancelRoute,
  leaseRequestCreateRoute,
  leaseRequestEventsRoute,
  leaseRequestGetRoute,
  leaseRequestListRoute,
  type leaseRequestViewSchema,
  requestsReplySchema,
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
import { OutputRelay } from "./output-relay.js";
import { pipeSse } from "./sse.js";
import type { Auth, Identity } from "../auth/index.js";
import {
  buildLeasePayload,
  type HttpLeaseDevice,
  isTerminalStage,
  type LeaseRequestInput,
  type LeaseRequestReader,
  LeaseRequestTracker,
  type TrackedRequestView,
} from "./tracker.js";

/**
 * The device fields the lease routes read: what a lease payload is built from, plus two that
 * only one kind of daemon has. A worker's own registry record carries `state`, which `DELETE
 * /v1/leases/:id` reports; a gateway holds no device state of its own and leaves it out rather
 * than inventing one. A gateway's device carries the `workerId` it lives on, because a device
 * id is one worker's claim and is matched only together with the lease's own `workerId`.
 */
export interface HttpRegistryDevice extends HttpLeaseDevice {
  readonly state?: DeviceRecord["state"];
  readonly workerId?: string;
}

/** Minimal structural read surface -- narrower than importing the `Registry` class itself. Kept
 * for the one thing dispatcher operations don't hand back: a device record for a specific
 * lease's `GET /v1/leases/:id` decoration (there is no per-id device operation). A worker
 * passes its registry; a gateway passes the devices its worker views hold in the grant shape. */
export interface HttpRegistryReader {
  readonly snapshot: {
    readonly devices: readonly HttpRegistryDevice[];
  };
}

export interface HttpGatewayDeps {
  /** ADR 0003 §2: the exact same shared `Dispatcher` the socket path uses -- see
   * `dispatcher-session.ts`'s `HttpDispatch`. */
  readonly dispatch: HttpDispatch;
  readonly registry: HttpRegistryReader;
  /** The daemon's stored lease requests: a worker's request book, or a gateway's. */
  readonly leaseRequests: LeaseRequestReader;
  readonly eventBus: EventBus;
  /** ADR §8: fed to `LeaseNoticeBuffer` instead of it subscribing to `eventBus` itself. */
  readonly ownerRoutedFacts: OwnerRoutedFacts;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly config: Config;
  readonly auth: Pick<Auth, "authenticateRequest">;
  /** `false` on a gateway, which never downloads: `allowDownload` then does not answer the lease
   * request `POST` early. Default `true`. */
  readonly answerDownloadsEarly?: boolean | undefined;
  readonly mounts?: readonly HttpMount[];
}

export interface HttpMount {
  readonly prefix: string;
  handle(request: Request, identity: Identity): Promise<Response>;
}

type Env = AuthEnv;

/** Upper bound on `?wait=` long-polls; bounds how long an abandoned poll can pin resources. */
const MAX_LONG_POLL_SECONDS = 60;

function toLeaseRequestInput(body: z.infer<typeof leaseRequestBodySchema>): LeaseRequestInput {
  return {
    ...(body.device === undefined ? {} : { device: body.device }),
    ...(body.class === undefined ? {} : { class: body.class }),
    platform: body.platform,
    ...leaseRequestOptionFields(body),
    ...leaseRequestNameFields(body),
  };
}

function leaseRequestNameFields(body: z.infer<typeof leaseRequestBodySchema>) {
  return {
    ...(body.owner === undefined ? {} : { owner: body.owner }),
    ...(body.leaseId === undefined ? {} : { leaseId: body.leaseId }),
  };
}

function leaseRequestOptionFields(body: z.infer<typeof leaseRequestBodySchema>) {
  return {
    ...(body.os === undefined ? {} : { os: body.os }),
    ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
    ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
    ...(body.mode === undefined ? {} : { mode: body.mode }),
    ...(body.imageTag === undefined ? {} : { imageTag: body.imageTag }),
    ...(body.physical === undefined ? {} : { physical: body.physical }),
  };
}

export interface HttpAppDisposable {
  readonly dispose: () => void;
}

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

  // The one error boundary. Hono's `compose` catches a thrown error at the layer that threw
  // it and hands it to `app.onError` right there -- it never propagates up through an outer
  // middleware's own `await next()` -- so this has to be `onError`, not a try/catch here.
  app.onError((error, c) => {
    const mapped = mapError(error);
    if (mapped.code === "INTERNAL") {
      logger.error("Unhandled request error", { message: errorMessage(error), path: c.req.path });
    }
    return errorResponse(c, error);
  });

  // "One structured line per request outcome" -- by the time `next()` resolves, `onError`
  // above has already run for a thrown error and `c.res` reflects the mapped status.
  app.use("*", async (c, next) => {
    const start = deps.clock.now();
    await next();
    // The one unauthenticated route is also the one a tunnel/load-balancer polls: logging it
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

  // why: Hono's `etag()` buffers the body to hash it, so it runs only under /v1 (a `*` step, so no `/v1/*` route is registered) on a JSON answer to a GET that is not a mount's; a stream or a mount's own body is never read.
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

  app.openapi({ ...leaseRequestCreateRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("Idempotency-Key");
    const outcome = await tracker.submit(identity, toLeaseRequestInput(body), idempotencyKey);
    if (outcome.kind === "rejected") throw outcome.error;
    c.header("Location", `/v1/lease-requests/${outcome.view.id}`);
    return c.json({ request: serializeRequest(outcome.view) }, 201);
  });

  // why: operator-role in effect: `list.get` is an admin operation, so an agent token gets `FORBIDDEN`/403 from the shared dispatcher.
  app.openapi({ ...leaseRequestListRoute, middleware: [agentAuth] }, async (c) => {
    const requests = await deps.dispatch(
      "list.get",
      { kind: "requests" },
      buildHttpSession(c.get("identity")),
    );
    return c.json(requestsReplySchema.parse({ requests }), 200);
  });

  app.openapi({ ...leaseRequestGetRoute, middleware: [agentAuth] }, async (c) => {
    const id = c.req.valid("param").id;
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), initial.ownerId);

    const { wait } = c.req.valid("query");
    if (wait !== undefined) {
      // Clamped, not rejected: an oversized wait still long-polls correctly -- the client
      // simply re-polls sooner than it asked -- and the clamp bounds how long an abandoned
      // poll can pin its listener and timer. Aborting the request releases them immediately.
      await tracker.waitForChange(
        id,
        Math.min(Number(wait), MAX_LONG_POLL_SECONDS),
        c.req.raw.signal,
      );
    }

    const view = tracker.get(id) ?? initial;
    return c.json({ request: serializeRequest(view) }, 200);
  });

  app.openapi({ ...leaseRequestEventsRoute, middleware: [agentAuth] }, (c) => {
    const id = c.req.valid("param").id;
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), initial.ownerId);

    return pipeSse(
      c,
      deps.clock,
      {
        subscribe(send, end) {
          const current = tracker.get(id) ?? initial;
          send({ data: serializeRequest(current), event: current.state.stage });
          if (isTerminalStage(current.state)) {
            end();
            return () => {};
          }
          const unsubscribe = tracker.subscribe(id, (state) => {
            send({ data: serializeRequest({ ...current, state }), event: state.stage });
            if (isTerminalStage(state)) end();
          });
          // why: nothing in this process is driving the request -- one a restarted daemon has not
          // settled yet -- so no change will ever arrive on this stream: end it rather than
          // hold it open. The client reconnects and reads the settled state.
          if (unsubscribe === undefined) {
            end();
            return () => {};
          }
          return unsubscribe;
        },
      },
      c.get("identity").expiresAt,
    );
  });

  app.openapi({ ...leaseRequestCancelRoute, middleware: [agentAuth] }, async (c) => {
    const id = c.req.valid("param").id;
    const existing = tracker.get(id);
    if (existing === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), existing.ownerId);

    const outcome = await tracker.cancel(id, c.get("identity"));
    if (outcome.kind === "cancelled") return c.body(null, 204);
    if (outcome.kind === "not-found") throw unknownRequest(id);
    if (outcome.leaseId !== undefined) {
      throw requestNotCancellable(
        `Request already granted lease ${outcome.leaseId}; release it instead`,
        { leaseId: outcome.leaseId },
      );
    }
    throw requestNotCancellable(
      "Request is no longer cancellable -- device work is already in flight for it",
    );
  });

  app.openapi({ ...leaseGetRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const lease = await findOwnedLease(deps, session, c.req.valid("param").id);
    const device = findDevice(deps, lease);
    if (device === undefined) throw unknownLease(lease.id);
    // ADR 0004: `ttlMs` comes off the lease record itself, so a payload served after a daemon
    // restart reports the lease's real width rather than a mode default standing in for a
    // per-request value this gateway no longer remembers. `requestId` is still gateway-side
    // bookkeeping, and is still the one field a restart can drop.
    const requestId = tracker.requestIdForLease(lease.id);
    return c.json(
      { lease: buildLeasePayload(device, lease, requestId === undefined ? {} : { requestId }) },
      200,
    );
  });

  app.openapi({ ...leaseRenewRoute, middleware: [agentAuth, emptyBodyAsNone] }, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const id = c.req.valid("param").id;
    const { ttlMs } = c.req.valid("json");

    // why: Dispatched directly (not via `findOwnedLease`/`lease.get`) so `lease.renew`'s own
    // `ownsLease` authorize hook answers -- an unowned lease is `FORBIDDEN`/403, matching the
    // socket transport, rather than the `UNKNOWN_LEASE`/404 `lease.get`'s hidden-lease answer would produce
    // (S6). An unknown id still surfaces as `UNKNOWN_LEASE`/404 from the handler itself, and a
    // `ttlMs` above `lease.maxTtlMs` as `BAD_REQUEST`/400 -- the cap lives in the shared
    // dispatcher, and this route awaits it, so there is nothing to restate here. Answering it
    // earlier would answer it *before* `ownsLease` and turn another requester's lease into a
    // 400 about its TTL where the socket and the HTTP API both say 403. An omitted
    // `ttlMs` re-applies the lease's own stored width (ADR 0004 §4), which is why nothing is
    // recorded here afterwards.
    const renewed = await deps.dispatch(
      "lease.renew",
      { leaseId: id, ...(ttlMs === undefined ? {} : { ttlMs }) },
      session,
    );

    return c.json(
      {
        expiresAt: new Date(renewed.ttlDeadline).toISOString(),
        leaseId: renewed.id,
        notices: notices.drain(id),
      },
      200,
    );
  });

  app.openapi({ ...leaseExecRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const leaseId = c.req.valid("param").id;
    const { requesterId, ...body } = c.req.valid("json");
    // Requester identity is the token's over HTTP, never the body's -- except for an
    // `operator` token, which is the proxying case `device.exec` reads it for. An agent
    // token that supplies one at all is refused, but by `device.exec`'s own `authorize`
    // hook (round 4, F4) rather than a route-level check: ADR 0003 §2 puts a contract
    // operation's answer in the dispatcher, not a transport, so the same request over the
    // unix socket or a future uplink gets the same `FORBIDDEN` this route now inherits
    // rather than defining.

    // why: dispatched directly, like `renew`/`release` and unlike the single-lease *reads*: this
    // route mutates a device, so it answers `device.exec`'s own ownership hook -- 403 for
    // another requester's lease, 404 for an id that names none -- rather than the 404-for-both
    // `lease.get` would produce (see `findOwnedLease`'s comment).
    // Where a chunk goes at each stage of this request's life, including after the client
    // disconnects -- see `OutputRelay`, which is where the "retain nothing then" rule lives
    // and is tested.
    const relay = new OutputRelay();
    let onStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      onStarted = resolve;
    });

    const settled = deps
      .dispatch(
        "device.exec",
        { leaseId, ...body, ...(requesterId === undefined ? {} : { requesterId }) },
        buildHttpSession(identity, {
          onStarted: () => onStarted(),
          // The relay's answer is this chunk's SSE write, and returning it is what stops
          // the command while a client is not reading (ADR 0005 §19e).
          onOutput: (stream, chunk) => relay.push({ chunk, stream }),
        }),
      )
      .then(
        (result) => ({ exitCode: result.exitCode, kind: "exited" }) as const,
        (error: unknown) => ({ error, kind: "failed" }) as const,
      );

    // An SSE response cannot take back its status code, so the decision point is the moment
    // the process exists: every failure that can precede one -- an unowned lease, an unknown
    // one, a refused verb, an unknown tool, a daemon still starting -- lands before
    // `onStarted` and is answered as an ordinary JSON error with its own status. After it,
    // the stream is committed, which is what gets a silent long-running command its `200`
    // and its keepalives immediately, and what makes `EXEC_TIMEOUT` always arrive as the
    // stream's terminal `error` event (ADR 0005 §19e).
    const outcome = await Promise.race([settled, started.then(() => undefined)]);
    if (outcome?.kind === "failed") return errorResponse(c, outcome.error);

    return pipeSse(c, deps.clock, {
      subscribe(send, end) {
        relay.attach((chunk) => send({ data: chunk, event: "output" }));
        void settled.then((result) => {
          if (result.kind === "exited") {
            send({ data: { exitCode: result.exitCode }, event: "exit" });
          } else {
            const mapped = mapError(result.error);
            send({
              data: { error: { code: mapped.code, message: mapped.message } },
              event: "error",
            });
          }
          end();
        });
        // The command keeps running after a client disconnects; what ends here is this
        // route's interest in its output, terminally.
        return () => relay.drop();
      },
    });
  });

  app.openapi({ ...componentInstallRoute, middleware: [agentAuth] }, async (c) => {
    const { workers, ...component } = c.req.valid("json");
    // Progress that arrives before the stream opens is held in order and flushed when it
    // does. After the client is gone, a write is a no-op (`pipeSse`); the install itself
    // carries on, and a repeat of this request joins it (ADR 0010 §6). Through a gateway each
    // update names the worker it came from (§7).
    type ProgressEvent = ComponentProgress & { readonly workerId?: string };
    const early: ProgressEvent[] = [];
    let deliver: ((progress: ProgressEvent) => void) | undefined;
    let onAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      onAdmitted = resolve;
    });
    const session = buildHttpSession(c.get("identity"), {
      onStarted: () => onAdmitted(),
      onComponentProgress: (progress, workerId) => {
        const event = workerId === undefined ? progress : { ...progress, workerId };
        if (deliver === undefined) early.push(event);
        else deliver(event);
      },
    });

    // `workers` names the gateway's relay: it asks each worker and answers with one result per
    // worker. Without it, the install runs on the daemon this request reached.
    const dispatched: Promise<unknown> =
      workers === undefined
        ? deps.dispatch("component.install", component, session)
        : deps.dispatch("worker.install-component", { ...component, workers }, session);
    const settled = dispatched.then(
      (result) => ({ kind: "done", result }) as const,
      (error: unknown) => ({ error, kind: "failed" }) as const,
    );

    // The same decision point as the exec route: every refusal that comes before an install
    // (the token's role, the input, `downloads.policy`, a platform with no driver) is an
    // ordinary JSON error with its own status. Once the installer has taken the call, the
    // response is committed to a stream, which is what gives a call waiting behind another
    // download its `200` and its keepalives at once. Bounded by the install's own budget,
    // `downloads.timeoutMs`, which ends the call with `DOWNLOAD_TIMEOUT`. Through a gateway the
    // decision point is the moment the targets are resolved: an unknown or unreachable worker
    // named in `workers` is still a JSON error, and each worker's call is bounded by its own
    // budget plus the gateway's backstop.
    const outcome = await Promise.race([settled, admitted.then(() => undefined)]);
    if (outcome?.kind === "failed") return errorResponse(c, outcome.error);

    return pipeSse(c, deps.clock, {
      subscribe(send, end) {
        deliver = (progress) => void send({ data: progress, event: "progress" });
        for (const progress of early.splice(0)) deliver(progress);
        void settled.then((result) => {
          if (result.kind === "done") {
            send({ data: result.result, event: "result" });
          } else {
            const mapped = mapError(result.error);
            send({
              data: { error: { code: mapped.code, message: mapped.message } },
              event: "error",
            });
          }
          end();
        });
        return () => undefined;
      },
    });
  });

  app.openapi({ ...leaseEventsRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const lease = await findOwnedLease(deps, buildHttpSession(identity), c.req.valid("param").id);

    return pipeSse(
      c,
      deps.clock,
      {
        subscribe(send, end) {
          return notices.subscribe(lease.id, (notice) => {
            send({ data: notice, event: notice.event });
            if (notice.event === "lease_lost") end();
          });
        },
      },
      identity.expiresAt,
    );
  });

  app.openapi({ ...leaseReleaseRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const id = c.req.valid("param").id;

    // why: best-effort lookup, only to decorate the response with the device id/state --
    // `lease.release`'s output schema is `{ leaseId }` alone (no `deviceId`), so this is still
    // needed for the response body. It is *not* the authorization decision: `lease.release`
    // below is dispatched directly and is the sole source of truth for whether this request is
    // allowed (S6). Its `ownsLease` hook answers `FORBIDDEN`/403 for someone else's lease and
    // the handler answers `UNKNOWN_LEASE`/404 for a nonexistent one, matching the socket
    // transport exactly.
    const lease = await findLeaseForDecoration(deps, session, id);

    await deps.dispatch("lease.release", { leaseId: id }, session);

    // A gateway holds no device state, so its answer is always the `reclaiming` default.
    const device = lease === undefined ? undefined : findDevice(deps, lease);
    return c.json(
      {
        device: { id: lease?.deviceId ?? id, state: device?.state ?? "reclaiming" },
        released: true as const,
      },
      202,
    );
  });

  app.openapi({ ...leaseListRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("lease.list", {}, buildHttpSession(c.get("identity"))), 200),
  );

  // The token records, for a console to name a lease's holder by its token's label. `token.list`
  // is an admin operation, so an agent token gets `FORBIDDEN`/403 from the shared dispatcher, and
  // its output schema has no secret and no hash, so neither can reach the body.
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

  // ADR 0005 §23's worker routes, registered in both modes (ADR 0012 §3). A worker answers them
  // as a fleet of one: `GET /v1/workers` lists this host, and the drain, undrain and remove
  // routes answer `501 UNSUPPORTED_IN_WORKER_MODE` from its dispatcher.
  //
  // Operator-role in effect: `worker.*` are admin operations, so an agent token gets
  // `FORBIDDEN`/403 from the shared dispatcher rather than from a second check here.
  app.openapi({ ...workerListRoute, middleware: [agentAuth] }, async (c) =>
    c.json(await deps.dispatch("worker.list", {}, buildHttpSession(c.get("identity"))), 200),
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
    const { before, limit, since } = c.req.valid("query");
    const answer = eventsPageQuery({ before, limit, since });
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
    // Role check + startup-readiness parking, same as every other dispatched operation; the
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

  for (const mount of deps.mounts ?? []) {
    const handler = (c: Context<Env>) => mount.handle(c.req.raw, c.get("identity"));
    app.all(`/v1/${mount.prefix}`, agentAuth, handler);
    app.all(`/v1/${mount.prefix}/*`, agentAuth, handler);
  }

  // `notices` holds a subscription for the app's lifetime -- exposed here rather than left to
  // leak, so a caller composing this app into a longer-lived process (the daemon) can
  // unsubscribe it on shutdown.
  return Object.assign(app, {
    dispose: () => {
      notices.dispose();
    },
  });
}

// why: no dispatcher operation reads a stored lease request by id, so there is no `authorize` hook to reuse; compared against the record's `ownerId`, the principal the daemon saw send it, never its caller-claimed `requesterId`.
function requireOwnRequest(identity: Identity, ownerId: string): void {
  if (identity.role === "operator" || identity.principal === ownerId) return;
  throw forbidden("Not permitted to access another requester's resource");
}

// why: `lease.get` answers `UNKNOWN_LEASE` for a lease that does not exist and for one the session does not own alike, so the 404 does not tell them apart (the narrower, deliberate divergence from the mutating routes below that the known gaps in src/http/AGENTS.md describe).
async function findOwnedLease(
  deps: HttpGatewayDeps,
  session: ReturnType<typeof buildHttpSession>,
  id: string,
) {
  const { lease } = await deps.dispatch("lease.get", { leaseId: id }, session);
  return lease;
}

/** Best-effort lease lookup for a lease id, scoped to what the session's `lease.list` would
 * show it (own leases; admin sees all) -- used only to decorate a response after an
 * authoritative dispatch has already decided whether the request is allowed. Never used to
 * gate access itself (see the `DELETE /v1/leases/:id` route). */
async function findLeaseForDecoration(
  deps: HttpGatewayDeps,
  session: ReturnType<typeof buildHttpSession>,
  id: string,
) {
  const { leases } = await deps.dispatch("lease.list", {}, session);
  return leases.find((candidate) => candidate.id === id);
}

function serializeRequest(
  view: Pick<TrackedRequestView, "id" | "createdAt" | "state">,
): z.infer<typeof leaseRequestViewSchema> {
  const base = { createdAt: view.createdAt, id: view.id };
  switch (view.state.stage) {
    case "queued":
      return { ...base, queuePosition: view.state.queuePosition, state: "queued" };
    case "downloading": {
      // `component`, `waiting` and `percent` when there is one, as the tracker built them.
      const { stage: _stage, ...download } = view.state;
      return { ...base, ...download, state: "downloading" };
    }
    case "provisioning":
    case "booting":
    case "reclaiming":
      return { ...base, etaSeconds: view.state.etaSeconds, state: view.state.stage };
    case "granted":
      return { ...base, lease: view.state.lease, state: "granted" };
    case "failed":
      return { ...base, error: view.state.error, state: "failed" };
    case "cancelled":
      return { ...base, state: "cancelled" };
  }
}

/** The device a lease names. On a gateway both carry the `workerId` they came from, and a
 * device matches only on the lease's own worker: a device id is that worker's claim, so another
 * worker reporting the same id never answers for it. On a worker neither carries one. */
function findDevice(
  deps: HttpGatewayDeps,
  lease: { readonly deviceId: string; readonly workerId?: string | undefined },
): HttpRegistryDevice | undefined {
  return deps.registry.snapshot.devices.find(
    (device) => device.id === lease.deviceId && device.workerId === lease.workerId,
  );
}

// why: an empty body is no body whatever its content type: a renew without one keeps the lease's own width.
async function emptyBodyAsNone(c: Context, next: () => Promise<void>): Promise<void> {
  const isJson = /^application\/([a-z-.]+\+)?json/i.test(c.req.header("content-type") ?? "");
  if ((await c.req.text()).trim() === "") {
    // why: the validator reads the body only under a JSON content type, so an empty one is relabelled; `bodyCache.text` is typed as the string but holds the pending read, and the JSON validator parses what it holds, so `{}` stands in for the empty text.
    if (!isJson) c.req.raw.headers.set("content-type", "application/json");
    Object.assign(c.req.bodyCache, { text: Promise.resolve("{}") });
  }
  await next();
}

/** HTTP-only sugar translating `?since=5m` into the absolute `sinceTs` `events.replay` takes --
 * not a duplicate of any daemon-side logic (the operation itself takes an absolute timestamp),
 * so it is not one of the re-implementations ADR §2 says fall away with the dispatcher move. */
function parseDuration(value: string): number {
  const milliseconds = parseDurationMs(value);
  if (milliseconds === undefined) throw badRequest(`Invalid duration: ${value}`);
  return milliseconds;
}

function optionalQuery<Name extends string>(
  value: string | undefined,
  name: Name,
): { [Key in Name]?: string } {
  return value === undefined ? {} : ({ [name]: value } as { [Key in Name]?: string });
}

function statsRefusal(refusal: UsageWindowRefusal): string {
  switch (refusal.problem) {
    case "since-and-from":
      return "stats takes since or from, not both";
    case "to-without-from":
      return "to needs from";
    case "not-before-to":
      return "from must be earlier than to, or than now when to is left out";
    case "bad-duration":
      return `Invalid duration: ${refusal.value}`;
    case "bad-time":
      return `Invalid time: ${refusal.value} (use ISO 8601 with Z or an offset)`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
