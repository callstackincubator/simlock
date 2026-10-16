/**
 * why: every field of a relayed exchange arrives over the wire, in both directions (ADR 0026), so each is bounded here
 * once and both ends parse through these.
 */
import { z } from "zod";

export const RELAY_MAX_HEADERS = 100;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const relayIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

// why: the channel id is wire input the worker checks before it accepts a channel (ADR 0028).
export const relayChannelSchema = z.string().regex(/^[A-Za-z0-9-]{1,32}$/);

export const relayHeadersSchema = z
  .array(
    z.tuple([
      z.string().min(1).max(256).regex(HEADER_NAME),
      z
        .string()
        .max(8192)
        .refine((value) => !/[\r\n]/.test(value) && !value.includes("\0")),
    ]),
  )
  .max(RELAY_MAX_HEADERS);

// why: the relay re-creates these on each side instead of carrying them.
const FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
]);

// why: a worker never holds a gateway credential (ADR 0026).
const GATEWAY_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-agent-device-token",
]);

export function isRelayFramingHeader(name: string): boolean {
  return FRAMING_HEADERS.has(name.toLowerCase());
}

export function relayHeaderPairs(
  headers: Headers,
  options: { readonly dropCredentials: boolean },
): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of headers) {
    if (FRAMING_HEADERS.has(name)) continue;
    if (options.dropCredentials && GATEWAY_CREDENTIAL_HEADERS.has(name)) continue;
    if (name === "set-cookie") continue;
    pairs.push([name, value]);
  }
  for (const cookie of headers.getSetCookie()) pairs.push(["set-cookie", cookie]);
  return pairs;
}
