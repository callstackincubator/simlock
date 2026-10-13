/**
 * why: every field of a relayed exchange arrives over the wire, in both directions (ADR 0026), so each is bounded here
 * once and both ends parse through these.
 */
import { z } from "zod";

export const RELAY_MAX_HEADERS = 100;
export const RELAY_MAX_CHUNK_BYTES = 262_144;
/** why: the base64 length of the largest chunk, rounded up to a whole quantum of four. */
const RELAY_MAX_CHUNK_CHARACTERS = 349_528;
export const RELAY_MAX_PUSH_BYTES = 256 * 1024;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const relayIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

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

export const relayChunkSchema = z.string().max(RELAY_MAX_CHUNK_CHARACTERS).regex(BASE64);

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
