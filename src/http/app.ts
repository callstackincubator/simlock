import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { EventBus } from "../bus/index.js";
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
import { pipeSse } from "./sse.js";
import type { TokenIdentity } from "./token-store.js";
import {
  buildLeasePayload,
  isTerminalStage,
  type LeaseRequestInput,
  LeaseRequestTracker,
  type TrackedRequestView,
} from "./tracker.js";

/** Minimal structural read surface -- narrower than importing the `Registry` class itself. Kept
 * for the one thing dispatcher operations don't hand back: a device record for a specific
 * lease's `GET /v1/leases/:id` decoration (there is no per-id device operation). */
export interface HttpRegistryReader {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
  };
}

export interface HttpGatewayDeps {
  /** ADR 0003 §2: the exact same shared `Dispatcher` the socket path uses -- see
   * `dispatcher-session.ts`'s `HttpDispatch`. */
  readonly dispatch: HttpDispatch;
  readonly registry: HttpRegistryReader;
  readonly eventBus: EventBus;
  /** ADR §8: fed to `LeaseNoticeBuffer` instead of it subscribing to `eventBus` itself. */
  readonly ownerRoutedFacts: OwnerRoutedFacts;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly config: Config;
  readonly tokens: { verify(secret: string): Promise<TokenIdentity | undefined> };
}

type Env = AuthEnv;

/** Upper bound on `?wait=` long-polls; bounds how long an abandoned poll can pin resources. */
const MAX_LONG_POLL_SECONDS = 60;
/** Idempotency keys are map keys held for the replay window; unbounded length is a memory lever. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const leaseRequestBodySchema = z.object({
  allowDownload: z.boolean().optional(),
  device: z.string().min(1),
  full: z.boolean().optional(),
  noWait: z.boolean().optional(),
  os: z.string().min(1).optional(),
  platform: z.enum(["ios", "android"]),
  timeoutMs: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().optional(),
});

function toLeaseRequestInput(body: z.infer<typeof leaseRequestBodySchema>): LeaseRequestInput {
  return {
    device: body.device,
    platform: body.platform,
    ...(body.os === undefined ? {} : { os: body.os }),
    ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
    ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
    ...(body.full === undefined ? {} : { full: body.full }),
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
 * lease-request resource tracker/notice buffer ADR §11 keeps HTTP-specific until #72.
 */
// fallow-ignore-next-line complexity -- route wiring for one focused resource surface; splitting it would scatter the shared closures (tracker, notices) across files for no clarity gain.
export function createHttpApp(deps: HttpGatewayDeps): Hono<Env> & HttpAppDisposable {
  const app = new Hono<Env>();
  const logger = deps.logger.child("http");
  const tracker = new LeaseRequestTracker({
    clock: deps.clock,
    defaultTtlMs: deps.config.lease.detachedTtlMs,
    dispatch: deps.dispatch,
    idGenerator: deps.idGenerator,
    logger,
  });
  const notices = new LeaseNoticeBuffer(deps.ownerRoutedFacts);
  // Replaces the tracker's own former direct `eventBus.subscribe("lease.released"/"lease.expired",
  // ...)` -- ADR §8's "consumes the owner-routed facts" applies here too, not just to `notices`.
  const unsubscribeLeaseBookkeeping = deps.eventBus.subscribe("lease.released", (envelope) =>
    tracker.forgetLease(envelope.payload.leaseId),
  );
  const unsubscribeExpiryBookkeeping = deps.eventBus.subscribe("lease.expired", (envelope) =>
    tracker.forgetLease(envelope.payload.leaseId),
  );

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

  app.post(
    "/v1/lease-requests",
    agentAuth,
    zValidator("json", leaseRequestBodySchema, (result, c) => {
      if (!result.success) {
        return errorResponse(c, badRequest(formatZodIssues(result.error.issues)));
      }
    }),
    async (c) => {
      const identity = c.get("identity");
      const body = c.req.valid("json");
      const idempotencyKey = c.req.header("Idempotency-Key");
      if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw badRequest(
          `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        );
      }

      const outcome = await tracker.submit(identity, toLeaseRequestInput(body), idempotencyKey);
      if (outcome.kind === "rejected") {
        return errorResponse(c, outcome.error);
      }
      c.header("Location", `/v1/lease-requests/${outcome.view.id}`);
      return c.json({ request: serializeRequest(outcome.view) }, 201);
    },
  );

  app.get("/v1/lease-requests/:id", agentAuth, async (c) => {
    const id = c.req.param("id");
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), initial.requesterId);

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
    requireOwnRequest(c.get("identity"), initial.requesterId);

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
        return unsubscribe ?? (() => {});
      },
    });
  });

  app.delete("/v1/lease-requests/:id", agentAuth, async (c) => {
    const id = c.req.param("id");
    const existing = tracker.get(id);
    if (existing === undefined) throw unknownRequest(id);
    requireOwnRequest(c.get("identity"), existing.requesterId);

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
    const device = findDevice(deps, lease.deviceId);
    if (device === undefined) throw unknownLease(lease.id);
    const requestId = tracker.requestIdForLease(lease.id);
    const ttlMs = tracker.effectiveTtlMs(lease.id) ?? modeDefaultTtlMs(lease, deps.config);
    return c.json({
      lease: buildLeasePayload(device, lease, {
        ...(requestId === undefined ? {} : { requestId }),
        ttlMs,
      }),
    });
  });

  app.post("/v1/leases/:id/renew", agentAuth, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const current = await findOwnedLease(deps, session, c.req.param("id"));
    const id = current.id;

    const ttlMs = await parseRenewBody(c);
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw badRequest("ttlMs must be a positive number");
    }

    const renewed = await deps.dispatch(
      "lease.renew",
      { leaseId: id, ...(ttlMs === undefined ? {} : { ttlMs }) },
      session,
    );
    tracker.recordLeaseTtl(id, ttlMs ?? modeDefaultTtlMs(current, deps.config));

    return c.json({
      expiresAt: new Date(renewed.ttlDeadline).toISOString(),
      leaseId: renewed.id,
      notices: notices.drain(id),
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
    const lease = await findOwnedLease(deps, session, c.req.param("id"));

    await deps.dispatch("lease.release", { leaseId: lease.id }, session);

    const device = findDevice(deps, lease.deviceId);
    return c.json(
      { device: { id: lease.deviceId, state: device?.state ?? "reclaiming" }, released: true },
      202,
    );
  });

  app.get("/v1/leases", agentAuth, async (c) =>
    c.json(await deps.dispatch("lease.list", {}, buildHttpSession(c.get("identity")))),
  );

  app.get("/v1/devices", agentAuth, async (c) => {
    const devices = await deps.dispatch(
      "list.get",
      { kind: "devices" },
      buildHttpSession(c.get("identity")),
    );
    return c.json({ devices });
  });

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

  // `tracker`/`notices` both hold subscriptions for the app's lifetime -- exposed here rather
  // than left to leak, so a caller composing this app into a longer-lived process (the daemon)
  // can unsubscribe them on shutdown.
  return Object.assign(app, {
    dispose: () => {
      unsubscribeLeaseBookkeeping();
      unsubscribeExpiryBookkeeping();
      tracker.dispose();
      notices.dispose();
    },
  });
}

/** HTTP-only guard for the lease-request tracker's resource (ADR §11: the envelope stays
 * HTTP-specific until #72, so there is no dispatcher `authorize` hook to reuse here the way
 * `lease.renew`/`lease.release`/`lease.cancel` do for core resources). Deliberately distinct
 * from the deleted general-purpose `requireOwnership` HTTP used to export from `auth.ts` --
 * every *core* resource's ownership now goes through the shared dispatcher instead. */
function requireOwnRequest(identity: TokenIdentity, requesterId: string): void {
  if (identity.role === "operator" || identity.requesterId === requesterId) return;
  throw forbidden("Not permitted to access another requester's resource");
}

/** `lease.list`'s dispatcher handler already filters to the session's own leases (admin sees
 * all) -- reusing it here for a single-lease lookup means an unauthorized id simply isn't in
 * the list, so `unknownLease` covers both "doesn't exist" and "not yours" the same way
 * `lease.list` itself does not distinguish them. */
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

function serializeRequest(
  view: Pick<TrackedRequestView, "id" | "createdAt" | "state">,
): Record<string, unknown> {
  const base = { createdAt: view.createdAt, id: view.id, state: view.state.stage };
  switch (view.state.stage) {
    case "queued":
      return { ...base, queuePosition: view.state.queuePosition };
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

/** The interval a default (body-less) renew of this lease applies -- its mode's configured TTL. */
function modeDefaultTtlMs(lease: { readonly mode: "held" | "detached" }, config: Config): number {
  return lease.mode === "held" ? config.lease.heldTtlBackstopMs : config.lease.detachedTtlMs;
}

function findDevice(deps: HttpGatewayDeps, id: string): DeviceRecord | undefined {
  return deps.registry.snapshot.devices.find((device) => device.id === id);
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

function formatZodIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
