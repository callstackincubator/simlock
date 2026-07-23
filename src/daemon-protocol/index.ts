/** The version of the newline-delimited JSON protocol spoken by daemon clients. */
export const DAEMON_PROTOCOL_VERSION = 1;

export type RequestId = string | number;

export interface RequestFrame {
  readonly id: RequestId;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Parses the transport-independent envelope. Domain payload validation belongs
 * to the daemon command handler, not to this protocol module.
 */
export function parseRequestFrame(value: unknown): RequestFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (
    (typeof frame.id !== "string" && typeof frame.id !== "number") ||
    typeof frame.type !== "string"
  ) {
    return undefined;
  }
  return { id: frame.id, payload: frame.payload, type: frame.type };
}

export function serializeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}
