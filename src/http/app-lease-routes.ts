import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ComponentProgress } from "../contract/index.js";
import { componentInstallRoute } from "./admin-declarations.js";
import type { Env, HttpAppContext } from "./app-types.js";
import {
  emptyBodyAsNone,
  findDevice,
  findLeaseForDecoration,
  findOwnedLease,
} from "./app-helpers.js";
import { buildHttpSession } from "./dispatcher-session.js";
import { errorResponse, mapError, unknownLease } from "./errors.js";
import {
  leaseEventsRoute,
  leaseExecRoute,
  leaseGetRoute,
  leaseListRoute,
  leaseRenewRoute,
  leaseReleaseRoute,
  leaseRotateRoute,
} from "./lease-declarations.js";
import { OutputRelay } from "./output-relay.js";
import { pipeSse } from "./sse.js";
import { buildLeasePayload } from "./tracker.js";

// why: the lease resource routes and the component-install stream, registered in the order the
// app serves them: each one's middleware and matching depend on that order, so the calls here
// must stay exactly as they were inline in `createHttpApp`.
export function registerLeaseRoutes(
  app: OpenAPIHono<Env>,
  { agentAuth, deps, notices, tracker }: HttpAppContext,
): void {
  app.openapi({ ...leaseGetRoute, middleware: [agentAuth] }, async (c) => {
    const identity = c.get("identity");
    const session = buildHttpSession(identity);
    const lease = await findOwnedLease(deps, session, c.req.valid("param").id);
    const device = findDevice(deps, lease);
    if (device === undefined) throw unknownLease(lease.id);
    // why: ADR 0004: `ttlMs` comes off the lease record itself, so a payload served after a daemon
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
    // why: Requester identity is the token's over HTTP, never the body's -- except for an
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
          onOutput: (stream, chunk) => relay.push({ chunk, stream }),
        }),
      )
      .then(
        (result) => ({ exitCode: result.exitCode, kind: "exited" }) as const,
        (error: unknown) => ({ error, kind: "failed" }) as const,
      );

    // why: An SSE response cannot take back its status code, so the decision point is the moment
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
        return () => relay.drop();
      },
    });
  });

  app.openapi({ ...componentInstallRoute, middleware: [agentAuth] }, async (c) => {
    const { workers, ...component } = c.req.valid("json");
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

    const dispatched: Promise<unknown> =
      workers === undefined
        ? deps.dispatch("component.install", component, session)
        : deps.dispatch("worker.install-component", { ...component, workers }, session);
    const settled = dispatched.then(
      (result) => ({ kind: "done", result }) as const,
      (error: unknown) => ({ error, kind: "failed" }) as const,
    );

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

  app.openapi({ ...leaseRotateRoute, middleware: [agentAuth] }, async (c) => {
    const { orientation } = c.req.valid("json");
    // why: dispatched directly, like `exec`, so `device.rotate`'s own authorize answers 403 for another requester's lease and the handler 404 for an unknown one.
    const rotated = await deps.dispatch(
      "device.rotate",
      { leaseId: c.req.valid("param").id, orientation },
      buildHttpSession(c.get("identity")),
    );
    return c.json(rotated, 200);
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
}
