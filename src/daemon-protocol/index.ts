/** The version of the newline-delimited JSON protocol spoken by daemon clients. */
export const DAEMON_PROTOCOL_VERSION = 2;

export type RequestId = string | number;

export interface RequestFrame {
  readonly id: RequestId;
  readonly type: string;
  readonly payload: unknown;
}

export type DaemonResponseFrame =
  | { readonly kind: "push"; readonly payload: unknown; readonly push: string }
  | { readonly error: unknown; readonly id: number; readonly kind: "failure" }
  | { readonly id: number; readonly kind: "success"; readonly payload: unknown };

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

/** Parses a response or server push frame without applying domain semantics. */
export function parseDaemonResponse(value: unknown): DaemonResponseFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.push === "string")
    return { kind: "push", payload: frame.payload, push: frame.push };
  if (typeof frame.id !== "number") return undefined;
  if (frame.ok === true) return { id: frame.id, kind: "success", payload: frame.payload };
  return { error: frame.error, id: frame.id, kind: "failure" };
}

export function serializeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}
