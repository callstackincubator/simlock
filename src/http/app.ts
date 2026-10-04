import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import { type ComponentProgress, describeSchemaIssues, imageTagSchema } from "../contract/index.js";
import type { Config, DeviceRecord } from "../core/index.js";
import type { OwnerRoutedFacts } from "../daemon/owner-routed-facts.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { type AuthEnv, requireAuth } from "./auth.js";
import { buildHttpSession, type HttpDispatch } from "./dispatcher-session.js";
import {
  badRequest,
  errorResponse,
  forbidden,
  mapError,
  requestNotCancellable,
  unknownLease,
  unknownRequest,
} from "./errors.js";
import { LeaseNoticeBuffer } from "./notices.js";
import { OutputRelay } from "./output-relay.js";
import { pipeSse } from "./sse.js";
import type { TokenIdentity } from "./token-store.js";
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
  readonly tokens: { verify(secret: string): Promise<TokenIdentity | undefined> };
  /** `false` on a gateway, which never downloads: `allowDownload` then does not answer the lease
   * request `POST` early. Default `true`. */
  readonly answerDownloadsEarly?: boolean | undefined;
}

type Env = AuthEnv;

/** Upper bound on `?wait=` long-polls; bounds how long an abandoned poll can pin resources. */
const MAX_LONG_POLL_SECONDS = 60;

/**
 * Strict (ADR 0007 §10): a body carrying a key this route does not know, the retired `full`
 * included, is `400 BAD_REQUEST` rather than having it silently dropped.
 */
const leaseRequestBodySchema = z
  .object({
    allowDownload: z.boolean().optional(),
    device: z.string().min(1),
    imageTag: imageTagSchema.optional(),
    mode: z.enum(["slim", "full"]).optional(),
    noWait: z.boolean().optional(),
    // ADR §27a (H7, round 2 review): declared and forwarded, not silently dropped -- the shared
    // dispatcher's own `lease.request` handler is the one place that decides whether this token
    // may set it (`FORBIDDEN` for non-admin), the same gate every other transport is held to.
    owner: z.string().min(1).optional(),
    os: z.string().min(1).optional(),
    platform: z.enum(["ios", "android"]),
    timeoutMs: z.number().int().positive().optional(),
    ttlMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `POST /v1/leases/{id}/exec`'s body: `device.exec`'s input minus `leaseId`, which the path
 * already names. Restated here rather than derived from the operation schema because that is
 * how every other route in this file states its body -- and because omitting `leaseId` from a
 * `.strict()` operation schema is not something `z.omit` can express without also dropping the
 * strictness that makes a typo an error.
 *
 * `tool` is a plain string, matching the operation: a name no driver on this machine wraps is
 * `UNKNOWN_PASSTHROUGH_TOOL` (422) from the driver catalog, not a malformed body -- `400` here
 * means the body's *shape* is wrong, nothing more.
 *
 * `stdin` and `requesterId` accept `null` as well as an omitted key, and normalize it to
 * omitted: the documented example sends `"stdin": null, "requesterId": null` to show the
 * fields exist, and a serializer that writes every optional field as `null` should not be a
 * `400`.
 */
const execBodySchema = z
  .object({
    tool: z.string().min(1),
    args: z.array(z.string()),
    stdin: z.string().nullish().transform(nullToUndefined),
    requesterId: z.string().nullish().transform(nullToUndefined),
  })
  .strict();

/** Shape only: what a valid platform, version and worker list are is `component.install`'s and
 * `worker.install-component`'s own contract schemas' answer, reached through the dispatcher like
 * every other transport's. `workers` present is what picks the gateway operation. */
const componentInstallBodySchema = z
  .object({
    platform: z.string(),
    version: z.string(),
    workers: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

/** A route's JSON body, validated against its schema; a body that fails is `400 BAD_REQUEST`. */
function jsonBody<Schema extends z.ZodTypeAny>(schema: Schema) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return errorResponse(c, badRequest(describeSchemaIssues(result.error.issues)));
    }
  });
}

function nullToUndefined<Value>(value: Value | null | undefined): Value | undefined {
  return value ?? undefined;
}

function toLeaseRequestInput(body: z.infer<typeof leaseRequestBodySchema>): LeaseRequestInput {
  return {
    device: body.device,
    platform: body.platform,
    ...(body.os === undefined ? {} : { os: body.os }),
    ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
    ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
    ...(body.mode === undefined ? {} : { mode: body.mode }),
    ...(body.imageTag === undefined ? {} : { imageTag: body.imageTag }),
    ...(body.owner === undefined ? {} : { owner: body.owner }),
  };
}

/** The gateway-owned subscriptions `createHttpApp` starts, attached to the returned app so a caller can dispose them on shutdown without this module exposing the tracker/notices instances themselves. */
export interface HttpAppDisposable {
  readonly dispose: () => void;
}

/**
 * `Request -> Response` app: no `node:http`, no `serve()` -- see `server.ts` for that. ADR
 * 0003 §2: "the HTTP app becomes routing plus a bearer-token-to-session adapter, calling the
 * same dispatcher in-process". Every route that maps onto a daemon operation calls
 * `deps.dispatch(...)`, which runs the exact same input parsing, role check, `authorize` hook,
 * and startup-readiness parking the socket path gets -- this file no longer re-implements any
 * of those. What's left here: HTTP routing, request/response (de)serialization, and the
 * lease-request resource's HTTP shape over the daemon's stored requests, and the notice buffer.
 */
// fallow-ignore-next-line complexity -- route wiring for one focused resource surface; splitting it would scatter the shared closures (tracker, notices) across files for no clarity gain.
export function createHttpApp(deps: HttpGatewayDeps): Hono<Env> & HttpAppDisposable {
  const app = new Hono<Env>();
  const logger = deps.logger.child("http");
  const tracker = new LeaseRequestTracker({
    clock: deps.clock,
    dispatch: deps.dispatch,
    requests: deps.leaseRequests,
    answerDownloadsEarly: deps.answerDownloadsEarly,
  });
  const notices = new LeaseNoticeBuffer(deps.ownerRoutedFacts);

  const agentAuth = requireAuth(deps.tokens);

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
    const identity = c.get("identity") as TokenIdentity | undefined;
    logger.info("request", {
      durationMs: deps.clock.now() - start,
      method: c.req.method,
      path: c.req.path,
      requesterId: identity?.requesterId,
      status: c.res.status,
    });
  });

  app.get("/v1/healthz", (c) => c.json({ ok: true }));

  app.get("/v1/status", agentAuth, async (c) =>
    c.json(await deps.dispatch("status.get", {}, buildHttpSession(c.get("identity")))),
  );

  app.get("/v1/catalog", agentAuth, async (c) => {
    const platform = c.req.query("platform");
    if (platform !== undefined && platform !== "ios" && platform !== "android") {
      throw badRequest("platform must be ios or android");
    }
    const result = await deps.dispatch(
      "catalog.get",
      platform === undefined ? {} : { platform },
      buildHttpSession(c.get("identity")),
    );
    return c.json(result);
  });

  app.get("/v1/components", agentAuth, async (c) => {
    const platform = c.req.query("platform");
    if (platform !== undefined && platform !== "ios" && platform !== "android") {
      throw badRequest("platform must be ios or android");
    }
    const result = await deps.dispatch(
      "component.list",
      platform === undefined ? {} : { platform },
      buildHttpSession(c.get("identity")),
    );
    return c.json(result);
  });

  // ADR 0010 §8: an admin removal, answered as one JSON body. Which platforms and versions are
  // valid, and who may remove, are `component.remove`'s own answers through the dispatcher.
  app.delete("/v1/components/:platform/:version", agentAuth, async (c) => {
    const dryRun = c.req.query("dryRun");
    if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false") {
      throw badRequest("dryRun must be true or false");
    }
    const result = await deps.dispatch(
      "component.remove",
      {
        platform: c.req.param("platform"),
        version: c.req.param("version"),
        ...(dryRun === undefined ? {} : { dryRun: dryRun === "true" }),
      },
      buildHttpSession(c.get("identity")),
    );
    return c.json(result);
  });

  app.post("/v1/lease-requests", agentAuth, jsonBody(leaseRequestBodySchema), async (c) => {
    const identity = c.get("identity");
    const body = c.req.valid("json");
    // Bounds and shape are `lease.request`'s own (`idempotencyKey`), checked by the dispatcher.
    const idempotencyKey = c.req.header("Idempotency-Key");
    const outcome = await tracker.submit(identity, toLeaseRequestInput(body), idempotencyKey);
    if (outcome.kind === "rejected") {
      return errorResponse(c, outcome.error);
    }
    c.header("Location", `/v1/lease-requests/${outcome.view.id}`);
    return c.json({ request: serializeRequest(outcome.view) }, 201);
  });

  // Every request waiting for a device, whoever sent it. Operator-role in effect: `list.get` is
  // an admin operation, so an agent token gets `FORBIDDEN`/403 from the shared dispatcher.
  app.get("/v1/lease-requests", agentAuth, async (c) => {
    const requests = await deps.dispatch(
      "list.get",
      { kind: "requests" },
      buildHttpSession(c.get("identity")),
    );
    return c.json({ requests });
  });

  app.get("/v1/lease-requests/:id", agentAuth, async (c) => {
    const id = c.req.param("id");
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), initial.ownerId);

    const waitParam = c.req.query("wait");
    if (waitParam !== undefined) {
      const seconds = Number(waitParam);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw badRequest("wait must be a non-negative number of seconds");
      }
      // Clamped, not rejected: an oversized wait still long-polls correctly -- the client
      // simply re-polls sooner than it asked -- and the clamp bounds how long an abandoned
      // poll can pin its listener and timer. Aborting the request releases them immediately.
      await tracker.waitForChange(id, Math.min(seconds, MAX_LONG_POLL_SECONDS), c.req.raw.signal);
    }

    const view = tracker.get(id) ?? initial;
    return c.json({ request: serializeRequest(view) });
  });

  app.get("/v1/lease-requests/:id/events", agentAuth, (c) => {
    const id = c.req.param("id");
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), initial.ownerId);

    return pipeSse(c, deps.clock, {
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
        // Nothing in this process is driving the request -- one a restarted daemon has not
        // settled yet -- so no change will ever arrive on this stream: end it rather than
        // hold it open. The client reconnects and reads the settled state.
        if (unsubscribe === undefined) {
          end();
          return () => {};
        }
        return unsubscribe;
      },
    });
  });

  app.delete("/v1/lease-requests/:id", agentAuth, async (c) => {
    const id = c.req.param("id");
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

  app.get("/v1/leases/:id", agentAuth, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const lease = await findOwnedLease(deps, session, c.req.param("id"));
    const device = findDevice(deps, lease);
    if (device === undefined) throw unknownLease(lease.id);
    // ADR 0004: `ttlMs` comes off the lease record itself, so a payload served after a daemon
    // restart reports the lease's real width rather than a mode default standing in for a
    // per-request value this gateway no longer remembers. `requestId` is still gateway-side
    // bookkeeping, and is still the one field a restart can drop.
    const requestId = tracker.requestIdForLease(lease.id);
    return c.json({
      lease: buildLeasePayload(device, lease, requestId === undefined ? {} : { requestId }),
    });
  });

  app.post("/v1/leases/:id/renew", agentAuth, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const id = c.req.param("id");

    const ttlMs = await parseRenewBody(c);
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw badRequest("ttlMs must be a positive number");
    }

    // Dispatched directly (not via `findOwnedLease`/`lease.list`) so `lease.renew`'s own
    // `ownsLease` authorize hook answers -- an unowned lease is `FORBIDDEN`/403, matching the
    // socket transport, rather than the `UNKNOWN_LEASE`/404 a `lease.list` filter would produce
    // (S6). An unknown id still surfaces as `UNKNOWN_LEASE`/404 from the handler itself, and a
    // `ttlMs` above `lease.maxTtlMs` as `BAD_REQUEST`/400 -- the cap lives in the shared
    // dispatcher, and this route awaits it, so there is nothing to restate here. Answering it
    // earlier would answer it *before* `ownsLease` and turn another requester's lease into a
    // 400 about its TTL where the socket and `docs/HTTP-API.md` both say 403. An omitted
    // `ttlMs` re-applies the lease's own stored width (ADR 0004 §4), which is why nothing is
    // recorded here afterwards.
    const renewed = await deps.dispatch(
      "lease.renew",
      { leaseId: id, ...(ttlMs === undefined ? {} : { ttlMs }) },
      session,
    );

    return c.json({
      expiresAt: new Date(renewed.ttlDeadline).toISOString(),
      leaseId: renewed.id,
      notices: notices.drain(id),
    });
  });

  app.post("/v1/leases/:id/exec", agentAuth, jsonBody(execBodySchema), async (c) => {
    const identity = c.get("identity");
    const leaseId = c.req.param("id");
    const { requesterId, ...body } = c.req.valid("json");
    // Requester identity is the token's over HTTP, never the body's -- except for an
    // `operator` token, which is the proxying case `device.exec` reads it for. An agent
    // token that supplies one at all is refused, but by `device.exec`'s own `authorize`
    // hook (round 4, F4) rather than a route-level check: ADR 0003 §2 puts a contract
    // operation's answer in the dispatcher, not a transport, so the same request over the
    // unix socket or a future uplink gets the same `FORBIDDEN` this route now inherits
    // rather than defining.

    // Dispatched directly, like `renew`/`release` and unlike the single-lease *reads*: this
    // route mutates a device, so it answers `device.exec`'s own ownership hook -- 403 for
    // another requester's lease, 404 for an id that names none -- rather than the 404-for-both
    // a `lease.list` filter would produce (see `findOwnedLease`'s comment).
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

  app.post("/v1/components/install", agentAuth, jsonBody(componentInstallBodySchema), async (c) => {
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

  app.get("/v1/leases/:id/events", agentAuth, async (c) => {
    const identity = c.get("identity");
    const lease = await findOwnedLease(deps, buildHttpSession(identity), c.req.param("id"));

    return pipeSse(c, deps.clock, {
      subscribe(send, end) {
        return notices.subscribe(lease.id, (notice) => {
          send({ data: notice, event: notice.event });
          if (notice.event === "lease_lost") end();
        });
      },
    });
  });

  app.delete("/v1/leases/:id", agentAuth, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const id = c.req.param("id");

    // Best-effort lookup, only to decorate the response with the device id/state --
    // `lease.release`'s output schema is `{ leaseId }` alone (no `deviceId`), so this is still
    // needed for the response body. It is *not* the authorization decision: `lease.release`
    // below is dispatched directly and is the sole source of truth for whether this request is
    // allowed (S6). Its `ownsLease` hook answers `FORBIDDEN`/403 for someone else's lease and
    // the handler answers `UNKNOWN_LEASE`/404 for a nonexistent one, matching the socket
    // transport exactly -- unlike the `lease.list`-filtered `findOwnedLease`, which always
    // answered 404 for both cases.
    const lease = await findLeaseForDecoration(deps, session, id);

    await deps.dispatch("lease.release", { leaseId: id }, session);

    // A gateway holds no device state, so its answer is always the `reclaiming` default.
    const device = lease === undefined ? undefined : findDevice(deps, lease);
    return c.json(
      {
        device: { id: lease?.deviceId ?? id, state: device?.state ?? "reclaiming" },
        released: true,
      },
      202,
    );
  });

  app.get("/v1/leases", agentAuth, async (c) =>
    c.json(await deps.dispatch("lease.list", {}, buildHttpSession(c.get("identity")))),
  );

  // The token records, for a console to name a lease's holder by its token's label. `token.list`
  // is an admin operation, so an agent token gets `FORBIDDEN`/403 from the shared dispatcher, and
  // its output schema has no secret and no hash, so neither can reach the body.
  app.get("/v1/tokens", agentAuth, async (c) =>
    c.json(await deps.dispatch("token.list", {}, buildHttpSession(c.get("identity")))),
  );

  app.get("/v1/devices", agentAuth, async (c) => {
    const devices = await deps.dispatch(
      "list.get",
      { kind: "devices" },
      buildHttpSession(c.get("identity")),
    );
    return c.json({ devices });
  });

  // ADR 0005 §23's worker routes, registered in both modes (ADR 0012 §3). A worker answers them
  // as a fleet of one: `GET /v1/workers` lists this host, and the drain, undrain and remove
  // routes answer `501 UNSUPPORTED_IN_WORKER_MODE` from its dispatcher.
  //
  // Operator-role in effect: `worker.*` are admin operations, so an agent token gets
  // `FORBIDDEN`/403 from the shared dispatcher rather than from a second check here.
  app.get("/v1/workers", agentAuth, async (c) =>
    c.json(await deps.dispatch("worker.list", {}, buildHttpSession(c.get("identity")))),
  );

  app.post("/v1/workers/:id/drain", agentAuth, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.drain",
        { workerId: c.req.param("id") },
        buildHttpSession(c.get("identity")),
      ),
    ),
  );

  app.delete("/v1/workers/:id/drain", agentAuth, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.undrain",
        { workerId: c.req.param("id") },
        buildHttpSession(c.get("identity")),
      ),
    ),
  );

  app.delete("/v1/workers/:id", agentAuth, async (c) =>
    c.json(
      await deps.dispatch(
        "worker.remove",
        { workerId: c.req.param("id") },
        buildHttpSession(c.get("identity")),
      ),
    ),
  );

  app.get("/v1/events", agentAuth, async (c) => {
    const since = c.req.query("since");
    const sinceTs = since === undefined ? undefined : deps.clock.now() - parseDuration(since);
    const events = await deps.dispatch(
      "events.replay",
      sinceTs === undefined ? {} : { sinceTs },
      buildHttpSession(c.get("identity")),
    );
    return c.json({ events });
  });

  app.get("/v1/events/stream", agentAuth, async (c) => {
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
    return pipeSse(c, deps.clock, {
      subscribe(send) {
        unsubscribeBus = deps.eventBus.subscribeAll((envelope) => {
          send({ data: envelope, event: envelope.event });
        });
        return () => {
          unsubscribeBus?.();
          unsubscribeBus = undefined;
        };
      },
    });
  });

  // `notices` holds a subscription for the app's lifetime -- exposed here rather than left to
  // leak, so a caller composing this app into a longer-lived process (the daemon) can
  // unsubscribe it on shutdown.
  return Object.assign(app, {
    dispose: () => {
      notices.dispose();
    },
  });
}

/** Guard for the lease-request routes. The request is the daemon's stored record now, but there
 * is still no dispatcher operation that reads one by id, so no `authorize` hook to reuse the way
 * `lease.renew`/`lease.release`/`lease.cancel` do. Compared against the record's `ownerId` --
 * the principal the daemon saw send it -- never its `requesterId`, which is the caller's claim.
 * A token's principal is its `requesterId` (`buildHttpSession`). */
function requireOwnRequest(identity: TokenIdentity, ownerId: string): void {
  if (identity.role === "operator" || identity.requesterId === ownerId) return;
  throw forbidden("Not permitted to access another requester's resource");
}

/** Read-only single-lease lookup for `GET /v1/leases/:id` and `GET /v1/leases/:id/events`.
 * There is no `lease.get` operation in the contract -- only `lease.renew`/`lease.release`
 * carry an `ownsLease` authorize hook to compare against -- so these two routes stay on
 * `lease.list`'s own filter (own leases; admin sees all): an unauthorized id simply isn't in
 * the list, and `unknownLease` covers both "doesn't exist" and "not yours" the same way
 * `lease.list` itself does not distinguish them, at 404. This is a deliberate, narrower
 * divergence than the one S6 fixed for the mutating routes below -- see
 * `docs/internal/KNOWN-PITFALLS.md` ("HTTP single-lease reads answer 404, not 403, for an unowned
 * lease"). */
async function findOwnedLease(
  deps: HttpGatewayDeps,
  session: ReturnType<typeof buildHttpSession>,
  id: string,
) {
  const { leases } = await deps.dispatch("lease.list", {}, session);
  const lease = leases.find((candidate) => candidate.id === id);
  if (lease === undefined) throw unknownLease(id);
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
): Record<string, unknown> {
  const base = { createdAt: view.createdAt, id: view.id, state: view.state.stage };
  switch (view.state.stage) {
    case "queued":
      return { ...base, queuePosition: view.state.queuePosition };
    case "downloading": {
      // `component`, `waiting` and `percent` when there is one, as the tracker built them.
      const { stage: _stage, ...download } = view.state;
      return { ...base, ...download };
    }
    case "provisioning":
    case "booting":
    case "reclaiming":
      return { ...base, etaSeconds: view.state.etaSeconds };
    case "granted":
      return { ...base, lease: view.state.lease };
    case "failed":
      return { ...base, error: view.state.error };
    case "cancelled":
      return base;
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

async function parseRenewBody(c: {
  req: { text(): Promise<string> };
}): Promise<number | undefined> {
  const raw = await c.req.text();
  if (raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw badRequest("Invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null) throw badRequest("Body must be a JSON object");
  const ttlMs = (parsed as Record<string, unknown>).ttlMs;
  if (ttlMs === undefined) return undefined;
  if (typeof ttlMs !== "number") throw badRequest("ttlMs must be a number");
  return ttlMs;
}

/** HTTP-only sugar translating `?since=5m` into the absolute `sinceTs` `events.replay` takes --
 * not a duplicate of any daemon-side logic (the operation itself takes an absolute timestamp),
 * so it is not one of the re-implementations ADR §2 says fall away with the dispatcher move. */
function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (match === null) throw badRequest(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw badRequest(`Invalid duration: ${value}`);
  return milliseconds;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
