/**
 * Protocol version range negotiation (ADR 0003 §6). Client and daemon each advertise
 * `{min, max}`; the negotiated version is the highest value both ranges contain.
 */
import { z } from "zod";

import { SimlockError } from "./errors.js";

export interface ProtocolRange {
  readonly min: number;
  readonly max: number;
}

const protocolRangeSchema = z.object({ min: z.number().int(), max: z.number().int() });

/**
 * The range this contract's daemon speaks. Both ends are 5, and every move that got it there
 * was breaking with no shim kept behind them, which is exactly when ADR 0003 §6's honesty
 * rule says a range must *not* widen: ADR 0004 removed `lease.heartbeat` and `mode` from the
 * wire (taking it to 4), and ADR 0005 adds `device.exec` and its `output` push family, a
 * `mode` field `status.get` now always carries, and the gateway surface -- `worker.*`,
 * `workerId`, the `worker` token role -- on top (taking it to 5). It only ever widens once a
 * second version is actually kept alive side by side with the first, which nothing here does.
 *
 * A client from before any of those changes simply does not overlap this daemon, and `hello`
 * fails with `PROTOCOL_VERSION_UNSUPPORTED` naming both ranges; `daemon.stop` stays the frozen
 * exception so the upgrade path (stop, then start the new daemon) exists at all. `status.get`'s
 * `mode` is the clearest reason this had to move rather than stay at 4: an older client parsing
 * that response against a schema without the field is not a compatibility story anyone kept, so
 * advertising 4 would be a claim to a compatibility path that does not exist.
 *
 * The consequence ADR 0005 §31 names: a pre-0005 worker's uplink negotiates nothing, so its
 * gateway marks it `incompatible` -- with both ranges on the view -- and never dispatches to it.
 */
export const PROTOCOL_VERSION_RANGE: ProtocolRange = { min: 5, max: 5 };

/**
 * The one protocol version that ever existed before ranges did. Used only to build the
 * `{min:2,max:2}` "daemon range" a client reports when it detects a legacy daemon's old-style
 * exact-match mismatch (see `mapLegacyProtocolMismatch`) -- there is no live protocol-2 daemon
 * in this repository to negotiate with; this constant documents the historical fact the ADR's
 * compatibility note depends on.
 */
export const LEGACY_DAEMON_PROTOCOL_VERSION = 2;

/** Highest version present in both ranges, or `undefined` if they do not overlap at all. */
export function negotiateProtocolVersion(
  client: ProtocolRange,
  daemon: ProtocolRange,
): number | undefined {
  const overlapMin = Math.max(client.min, daemon.min);
  const overlapMax = Math.min(client.max, daemon.max);
  return overlapMin <= overlapMax ? overlapMax : undefined;
}

/** A new daemon treats a bare number as `{n, n}` (ADR §6). */
export function normalizeProtocolVersion(value: number | ProtocolRange): ProtocolRange {
  return typeof value === "number" ? { min: value, max: value } : value;
}

/**
 * Builds the client-side error the ADR's compatibility note describes: a legacy protocol-2
 * daemon replies to `hello` with its own old-style `PROTOCOL_VERSION_MISMATCH` (no `{min,max}`
 * of its own -- that concept did not exist), so the client cannot learn the daemon's real
 * range from the wire. It reports the range as `{2,2}` because 2 is the only protocol version
 * that ever shipped without ranges -- see `LEGACY_DAEMON_PROTOCOL_VERSION`. `daemonVersion` is
 * `"unknown"` for the same reason: the legacy mismatch error carries no version string either.
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
    /** Legacy exact version, sent alongside `protocolRange` so an old protocol-2 daemon (which
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
