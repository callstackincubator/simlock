export interface DaemonConnection {
  request(type: string, payload: unknown): Promise<unknown>;
  onPush(listener: (kind: string, payload: unknown) => void): () => void;
  close(): Promise<void>;
}

export class DaemonClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export type DaemonResponseFrame =
  | { readonly kind: "push"; readonly payload: unknown; readonly push: string }
  | { readonly error: unknown; readonly id: number; readonly kind: "failure" }
  | { readonly id: number; readonly kind: "success"; readonly payload: unknown };

export function parseDaemonResponse(value: unknown): DaemonResponseFrame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.push === "string") {
    return { kind: "push", payload: frame.payload, push: frame.push };
  }
  if (typeof frame.id !== "number") return undefined;
  if (frame.ok === true) return { id: frame.id, kind: "success", payload: frame.payload };
  return { error: frame.error, id: frame.id, kind: "failure" };
}
