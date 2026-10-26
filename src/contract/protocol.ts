import { z } from "zod";

import { SimlockError } from "./errors.js";

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

const protocolRangeSchema = z.object({ min: z.number().int(), max: z.number().int() });

/** Widen only once a second version is kept alive side by side with the first; a bump that leaves no shim behind moves both ends. */
export const PROTOCOL_VERSION_RANGE: ProtocolRange = { min: 63, max: 63 };

const LEGACY_DAEMON_PROTOCOL_VERSION = 2;

export function negotiateProtocolVersion(
  client: ProtocolRange,
  daemon: ProtocolRange,
): number | undefined {
  const overlapMin = Math.max(client.min, daemon.min);
  const overlapMax = Math.min(client.max, daemon.max);
  return overlapMin <= overlapMax ? overlapMax : undefined;
}

export function normalizeProtocolVersion(value: number | ProtocolRange): ProtocolRange {
  return typeof value === "number" ? { min: value, max: value } : value;
}

/**
 * A legacy protocol-2 daemon sends no `{min,max}`, so its range is reported as `{2,2}`, the only version
 * that shipped without ranges; `daemonVersion` is `"unknown"` for the same reason.
 */
export function mapLegacyProtocolMismatch(
  clientRange: ProtocolRange,
  message: string,
): SimlockError<"PROTOCOL_VERSION_UNSUPPORTED"> {
  return new SimlockError("PROTOCOL_VERSION_UNSUPPORTED", "protocol", message, {
    client: clientRange,
    daemon: { min: LEGACY_DAEMON_PROTOCOL_VERSION, max: LEGACY_DAEMON_PROTOCOL_VERSION },
    daemonVersion: "unknown",
  });
}

/** What a client sends at `hello` (ADR §5, §6). `principal`/`credential` are declared now --
 * the reply shape and this input need to exist together -- but not read or enforced by the
 * daemon until PR 2's credential handshake. */
export const helloRequestSchema = z
  .object({
    clientVersion: z.string(),
    /** why: Legacy exact version, sent alongside `protocolRange` so an old protocol-2 daemon (which
     * only ever compares this field) still answers intelligibly. */
    protocolVersion: z.number().int().optional(),
    protocolRange: protocolRangeSchema.optional(),
    principal: z.string().optional(),
    credential: z.string().optional(),
  })
  .refine((value) => value.protocolVersion !== undefined || value.protocolRange !== undefined, {
    message: "hello requires protocolVersion, protocolRange, or both",
  });

/**
 * What the daemon replies with. `role` is declared now (every field a client will eventually
 * need to assert it got what it asked for, per ADR §5) but is a fixed value until PR 2 resolves
 * it from a real credential -- see `DaemonServer#handleHello`.
 *
 * `principal` is the connection's resolved, fixed-for-its-lifetime identity (ADR §4): what a
 * `hello` request supplied, or the daemon's own default (today: `defaultRequesterId`) when it
 * omitted one. Without this the client cannot learn its own principal in that fallback case, and
 * would otherwise have to guess -- see the abort-authorization defect this closes in
 * `simlock-client/client.ts`.
 */
export const helloReplySchema = z.object({
  protocolVersion: z.number().int(),
  daemonProtocolRange: protocolRangeSchema,
  version: z.string(),
  role: z.enum(["agent", "admin"]),
  principal: z.string(),
});

/** The first path segment of every route the HTTP app registers itself; a module's name may not start with one. */
export const CORE_ROUTE_SEGMENTS: readonly string[] = [
  "catalog",
  "components",
  "devices",
  "events",
  "healthz",
  "identity",
  "inbox",
  "lease-requests",
  "leases",
  "stats",
  "status",
  "tokens",
  "update",
  "uplink",
  "workers",
];
