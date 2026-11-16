import type { OpenAPIHono } from "@hono/zod-openapi";

import { type HttpAppContext, type Env } from "./app-types.js";
import {
  MAX_LONG_POLL_SECONDS,
  requireOwnRequest,
  serializeRequest,
  toLeaseRequestInput,
} from "./app-helpers.js";
import { buildHttpSession } from "./dispatcher-session.js";
import { requestNotCancellable, unknownRequest } from "./errors.js";
import {
  leaseRequestCancelRoute,
  leaseRequestCreateRoute,
  leaseRequestEventsRoute,
  leaseRequestGetRoute,
  leaseRequestListRoute,
  requestsReplySchema,
} from "./lease-declarations.js";
import { pipeSse } from "./sse.js";
import { isTerminalStage } from "./tracker.js";

// why: the lease-request resource routes, registered in the order the app serves them: each one's
// middleware and matching depend on that order, so the calls here must stay exactly as they were
// inline in `createHttpApp`.
export function registerLeaseRequestRoutes(
  app: OpenAPIHono<Env>,
  { agentAuth, deps, tracker }: HttpAppContext,
): void {
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
      // why: Clamped, not rejected: an oversized wait still long-polls correctly -- the client
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
}
