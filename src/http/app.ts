import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { EventBus } from "../bus/index.js";
import {
  type Config,
  type DeviceRecord,
  type LeaseRecord,
  transitionEnteredAt,
} from "../core/index.js";
import type {
  CapacityReader,
  CatalogReader,
  LeaseCommands,
  QueueControl,
} from "../core/lease-ports.js";
import type { Clock, IdGenerator, Logger } from "../ports/index.js";
import { type AuthEnv, requireAuth, requireOwnership } from "./auth.js";
import {
  badRequest,
  errorResponse,
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
  LeaseRequestTracker,
  type TrackedRequestView,
} from "./tracker.js";

/** Minimal structural read surface -- narrower than importing the `Registry` class itself. */
export interface HttpRegistryReader {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly leases: readonly LeaseRecord[];
  };
}

export interface HttpGatewayDeps {
  readonly leases: LeaseCommands;
  readonly queue: QueueControl;
  readonly capacity: CapacityReader;
  readonly catalog: CatalogReader;
  readonly registry: HttpRegistryReader;
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly config: Config;
  readonly tokens: { verify(secret: string): Promise<TokenIdentity | undefined> };
  readonly daemonHealth: () => "starting" | "running";
}

type Env = AuthEnv;

const leaseRequestBodySchema = z.object({
  allowDownload: z.boolean().optional(),
  device: z.string().min(1),
  noWait: z.boolean().optional(),
  os: z.string().min(1).optional(),
  platform: z.enum(["ios", "android"]),
  timeoutMs: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().optional(),
});

/** The gateway-owned subscriptions `createHttpApp` starts, attached to the returned app so a caller can dispose them on shutdown without this module exposing the tracker/notices instances themselves. */
export interface HttpAppDisposable {
  readonly dispose: () => void;
}

/** Pure `Request -> Response` app: no `node:http`, no `serve()` -- see `server.ts` for that. */
// fallow-ignore-next-line complexity -- route wiring for one focused resource surface; splitting it would scatter the shared closures (tracker, notices) across files for no clarity gain.
export function createHttpApp(deps: HttpGatewayDeps): Hono<Env> & HttpAppDisposable {
  const app = new Hono<Env>();
  const logger = deps.logger.child("http");
  const tracker = new LeaseRequestTracker({
    clock: deps.clock,
    defaultTtlMs: deps.config.lease.detachedTtlMs,
    eventBus: deps.eventBus,
    idGenerator: deps.idGenerator,
    leases: deps.leases,
    queue: deps.queue,
  });
  const notices = new LeaseNoticeBuffer(deps.eventBus);

  const agentAuth = requireAuth(deps.tokens);
  const operatorAuth = requireAuth(deps.tokens, "operator");

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

  app.get("/v1/status", agentAuth, (c) => c.json(buildStatus(deps)));

  app.get("/v1/catalog", agentAuth, async (c) => {
    const platform = c.req.query("platform");
    if (platform !== undefined && platform !== "ios" && platform !== "android") {
      throw badRequest("platform must be ios or android");
    }
    const platforms = await deps.catalog.listCatalog(platform);
    return c.json({ platforms });
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

      // `allowDownload` passes through unclamped, matching the socket daemon's handling of the
      // same flag; if a config-level download policy ever gates it there, this route must gate
      // through the same helper.
      const outcome = await tracker.submit(
        identity,
        {
          device: body.device,
          platform: body.platform,
          ...(body.os === undefined ? {} : { os: body.os }),
          ...(body.ttlMs === undefined ? {} : { ttlMs: body.ttlMs }),
          ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
          ...(body.noWait === undefined ? {} : { noWait: body.noWait }),
          ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
        },
        idempotencyKey,
      );
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
    requireOwnership(c.get("identity"), initial.requesterId);

    const waitParam = c.req.query("wait");
    if (waitParam !== undefined) {
      const seconds = Number(waitParam);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw badRequest("wait must be a non-negative number of seconds");
      }
      await tracker.waitForChange(id, seconds);
    }

    const view = tracker.get(id) ?? initial;
    return c.json({ request: serializeRequest(view) });
  });

  app.get("/v1/lease-requests/:id/events", agentAuth, (c) => {
    const id = c.req.param("id");
    const initial = tracker.get(id);
    if (initial === undefined) throw unknownRequest(id);
    requireOwnership(c.get("identity"), initial.requesterId);

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
    requireOwnership(c.get("identity"), existing.requesterId);

    const outcome = await tracker.cancel(id);
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

  app.get("/v1/leases/:id", agentAuth, (c) => {
    const lease = requireOwnedLease(c.get("identity"), deps, c.req.param("id"));
    const device = findDevice(deps, lease.deviceId);
    if (device === undefined) throw unknownLease(lease.id);
    const requestId = tracker.requestIdForLease(lease.id);
    const ttlMs = tracker.effectiveTtlMs(lease.id);
    return c.json({
      lease: buildLeasePayload(device, lease, {
        ...(requestId === undefined ? {} : { requestId }),
        ...(ttlMs === undefined ? {} : { ttlMs }),
      }),
    });
  });

  app.post("/v1/leases/:id/renew", agentAuth, async (c) => {
    const current = requireOwnedLease(c.get("identity"), deps, c.req.param("id"));
    const id = current.id;

    const ttlMs = await parseRenewBody(c);
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw badRequest("ttlMs must be a positive number");
    }

    const renewed = await deps.leases.renew(id, ttlMs);
    const effectiveTtlMs =
      ttlMs ??
      (current.mode === "held"
        ? deps.config.lease.heldTtlBackstopMs
        : deps.config.lease.detachedTtlMs);
    tracker.recordLeaseTtl(id, effectiveTtlMs);

    return c.json({
      expiresAt: new Date(renewed.ttlDeadline).toISOString(),
      leaseId: renewed.id,
      notices: notices.drain(id),
    });
  });

  app.get("/v1/leases/:id/events", agentAuth, (c) => {
    const lease = requireOwnedLease(c.get("identity"), deps, c.req.param("id"));

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
    const lease = requireOwnedLease(c.get("identity"), deps, c.req.param("id"));

    await deps.leases.release(lease.id, "explicit");

    const device = findDevice(deps, lease.deviceId);
    return c.json(
      { device: { id: lease.deviceId, state: device?.state ?? "reclaiming" }, released: true },
      202,
    );
  });

  app.get("/v1/leases", operatorAuth, (c) =>
    c.json({
      leases: deps.registry.snapshot.leases.map((lease) => decorateLease(lease, deps.config)),
    }),
  );

  app.get("/v1/devices", operatorAuth, (c) =>
    c.json({
      devices: deps.registry.snapshot.devices.map((device) => decorateDevice(device, deps.clock)),
    }),
  );

  app.get("/v1/events", operatorAuth, (c) => {
    const since = c.req.query("since");
    const sinceTs = since === undefined ? undefined : deps.clock.now() - parseDuration(since);
    return c.json({ events: deps.eventBus.replay(sinceTs === undefined ? {} : { sinceTs }) });
  });

  app.get("/v1/events/stream", operatorAuth, (c) =>
    pipeSse(c, deps.clock, {
      subscribe(send) {
        return deps.eventBus.subscribeAll((envelope) => {
          send({ data: envelope, event: envelope.event });
        });
      },
    }),
  );

  // `tracker`/`notices` both subscribe to `deps.eventBus` for the app's lifetime -- exposed
  // here rather than left to leak, so a caller composing this app into a longer-lived process
  // (the daemon) can unsubscribe them on shutdown. Attached to the app object itself instead
  // of changing this function's return shape to a `{app, dispose}` pair, which would ripple
  // into every existing call site.
  return Object.assign(app, {
    dispose: () => {
      tracker.dispose();
      notices.dispose();
    },
  });
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

/** Shared preamble of every `/v1/leases/:id` route: resolve the lease, then gate on ownership. */
function requireOwnedLease(
  identity: TokenIdentity,
  deps: HttpGatewayDeps,
  id: string,
): LeaseRecord {
  const lease = findLease(deps, id);
  if (lease === undefined) throw unknownLease(id);
  requireOwnership(identity, lease.requesterId);
  return lease;
}

function findLease(deps: HttpGatewayDeps, id: string): LeaseRecord | undefined {
  return deps.registry.snapshot.leases.find((lease) => lease.id === id);
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

/** Mirrors `DaemonServer#status` exactly -- see server.ts's `#status` -- so `--json` parity holds. */
function buildStatus(deps: HttpGatewayDeps): unknown {
  const snapshot = deps.registry.snapshot;
  const running = deps.capacity.runningCapacity;
  const warmDevices = snapshot.devices.filter((device) => device.state === "ready");
  const capacity = Object.fromEntries(
    (["ios", "android"] as const).map((platform) => [
      platform,
      {
        limit: deps.capacity.deviceLimit(platform),
        ...running[platform],
        used: snapshot.devices.filter(
          (device) => device.spec.platform === platform && device.state !== "deleted",
        ).length,
        warm: warmDevices.filter((device) => device.spec.platform === platform).length,
      },
    ]),
  );
  return {
    ...snapshot,
    capacity: { ...capacity, global: { ...running.global, warm: warmDevices.length } },
    devices: snapshot.devices.map((device) => decorateDevice(device, deps.clock)),
    health: deps.daemonHealth(),
    leases: snapshot.leases.map((lease) => decorateLease(lease, deps.config)),
    queueDepth: deps.queue.queueDepth,
  };
}

function decorateDevice(
  device: DeviceRecord,
  clock: Clock,
): DeviceRecord & { readonly transitionAgeMs?: number } {
  const enteredAt = transitionEnteredAt(device);
  if (enteredAt === undefined) return device;
  return { ...device, transitionAgeMs: clock.now() - enteredAt };
}

function decorateLease(
  lease: LeaseRecord,
  config: Config,
): LeaseRecord & { readonly lastHeartbeatAt?: number } {
  if (lease.mode !== "held") return lease;
  return { ...lease, lastHeartbeatAt: lease.ttlDeadline - config.lease.heldTtlBackstopMs };
}

/** Local re-implementation of the CLI's `parseDuration` -- the HTTP layer never imports `src/cli`. */
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
