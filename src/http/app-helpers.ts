import type { Context } from "hono";
import type { z } from "zod";

import type { Identity } from "../auth/index.js";
import { parseDurationMs, type UsageWindowRefusal } from "../contract/index.js";
import type { buildHttpSession } from "./dispatcher-session.js";
import { badRequest, forbidden } from "./errors.js";
import type { leaseRequestBodySchema, leaseRequestViewSchema } from "./lease-declarations.js";
import type { HttpGatewayDeps, HttpRegistryDevice } from "./app-types.js";
import type { LeaseRequestInput, TrackedRequestView } from "./tracker.js";

export const MAX_LONG_POLL_SECONDS = 60;

export function toLeaseRequestInput(
  body: z.infer<typeof leaseRequestBodySchema>,
): LeaseRequestInput {
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
    ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
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
    ...(body.except === undefined ? {} : { except: body.except }),
    ...(body.physical === undefined ? {} : { physical: body.physical }),
    ...leaseRequestImageFields(body),
  };
}

function leaseRequestImageFields(body: z.infer<typeof leaseRequestBodySchema>) {
  return {
    ...(body.imageTag === undefined ? {} : { imageTag: body.imageTag }),
    ...(body.baseline === undefined ? {} : { baseline: body.baseline }),
  };
}

// why: no dispatcher operation reads a stored lease request by id, so there is no `authorize` hook to reuse; compared against the record's `ownerId`, the principal the daemon saw send it, never its caller-claimed `requesterId`.
export function requireOwnRequest(identity: Identity, ownerId: string): void {
  if (identity.role === "operator" || identity.principal === ownerId) return;
  throw forbidden("Not permitted to access another requester's resource");
}

// why: `lease.get` answers `UNKNOWN_LEASE` for a lease that does not exist and for one the session does not own alike, so the 404 does not tell them apart (the narrower, deliberate divergence from the mutating routes below that the known gaps in src/http/AGENTS.md describe).
export async function findOwnedLease(
  deps: HttpGatewayDeps,
  session: ReturnType<typeof buildHttpSession>,
  id: string,
) {
  const { lease } = await deps.dispatch("lease.get", { leaseId: id }, session);
  return lease;
}

/** why: Best-effort lease lookup for a lease id, scoped to what the session's `lease.list` would
 * show it (own leases; admin sees all) -- used only to decorate a response after an
 * authoritative dispatch has already decided whether the request is allowed. Never used to
 * gate access itself (see the `DELETE /v1/leases/:id` route). */
export async function findLeaseForDecoration(
  deps: HttpGatewayDeps,
  session: ReturnType<typeof buildHttpSession>,
  id: string,
) {
  const { leases } = await deps.dispatch("lease.list", {}, session);
  return leases.find((candidate) => candidate.id === id);
}

export function serializeRequest(
  view: Pick<TrackedRequestView, "id" | "createdAt" | "state">,
): z.infer<typeof leaseRequestViewSchema> {
  const base = { createdAt: view.createdAt, id: view.id };
  switch (view.state.stage) {
    case "queued":
      return { ...base, queuePosition: view.state.queuePosition, state: "queued" };
    case "downloading": {
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

/** why: The device a lease names. On a gateway both carry the `workerId` they came from, and a
 * device matches only on the lease's own worker: a device id is that worker's claim, so another
 * worker reporting the same id never answers for it. On a worker neither carries one. */
export function findDevice(
  deps: HttpGatewayDeps,
  lease: { readonly deviceId: string; readonly workerId?: string | undefined },
): HttpRegistryDevice | undefined {
  return deps.registry.snapshot.devices.find(
    (device) => device.id === lease.deviceId && device.workerId === lease.workerId,
  );
}

// why: an empty body is no body whatever its content type: a renew without one keeps the lease's own width.
export async function emptyBodyAsNone(c: Context, next: () => Promise<void>): Promise<void> {
  const isJson = /^application\/([a-z-.]+\+)?json/i.test(c.req.header("content-type") ?? "");
  if ((await c.req.text()).trim() === "") {
    // why: the validator reads the body only under a JSON content type, so an empty one is relabelled; `bodyCache.text` is typed as the string but holds the pending read, and the JSON validator parses what it holds, so `{}` stands in for the empty text.
    if (!isJson) c.req.raw.headers.set("content-type", "application/json");
    Object.assign(c.req.bodyCache, { text: Promise.resolve("{}") });
  }
  await next();
}

/** why: HTTP-only sugar translating `?since=5m` into the absolute `sinceTs` `events.replay` takes --
 * not a duplicate of any daemon-side logic (the operation itself takes an absolute timestamp),
 * so it is not one of the re-implementations ADR §2 says fall away with the dispatcher move. */
export function parseDuration(value: string): number {
  const milliseconds = parseDurationMs(value);
  if (milliseconds === undefined) throw badRequest(`Invalid duration: ${value}`);
  return milliseconds;
}

export function optionalQuery<Name extends string>(
  value: string | undefined,
  name: Name,
): { [Key in Name]?: string } {
  return value === undefined ? {} : ({ [name]: value } as { [Key in Name]?: string });
}

export function statsRefusal(refusal: UsageWindowRefusal): string {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
