import { readReleaseScope } from "./release-scope.js";

const MAX_RPC_BODY_BYTES = 1024 * 1024;
const LEASE_ID = /^[0-9a-f]{32}$/;

export function leaseIdOf(value: unknown): string | undefined {
  return typeof value === "string" && LEASE_ID.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type RpcRead =
  | {
      readonly kind: "request";
      readonly text: string;
      readonly body: Record<string, unknown>;
      readonly id: unknown;
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | { readonly kind: "too-large" }
  | { readonly kind: "malformed" };

async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<string | undefined> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RPC_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readRpcBody(request: Request): Promise<RpcRead> {
  const text = await readBounded(request.body);
  if (text === undefined) return { kind: "too-large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  const body = record(parsed);
  if (body === undefined || typeof body["method"] !== "string") return { kind: "malformed" };
  return {
    body,
    id: body["id"] ?? null,
    kind: "request",
    method: body["method"],
    params: record(body["params"]) ?? {},
    text,
  };
}

export type CallClass = "allocate" | "heartbeat" | "release" | "wrapped-lease" | "command";

const LEASE_METHOD = /^agent[_-]device\.lease\.(allocate|heartbeat|release)$/;
const COMMAND_METHOD = /^agent[_-]device\.command$/;
const WRAPPED_LEASE = /^lease_(allocate|heartbeat|release)$/;

export function classifyCall(method: string, params: Record<string, unknown>): CallClass {
  const lease = LEASE_METHOD.exec(method)?.[1];
  if (lease !== undefined) return lease as "allocate" | "heartbeat" | "release";
  if (COMMAND_METHOD.test(method)) {
    const command = params["command"];
    if (typeof command === "string" && WRAPPED_LEASE.test(command)) return "wrapped-lease";
  }
  return "command";
}

export interface LeaseCallFields {
  readonly leaseId: unknown;
  readonly ttlMs: unknown;
  readonly platform: unknown;
  readonly target: unknown;
  readonly device: unknown;
  readonly udid: unknown;
  readonly serial: unknown;
  readonly deviceKey: unknown;
}

export function leaseCallFields(params: Record<string, unknown>): LeaseCallFields {
  return {
    device: params["device"],
    deviceKey: params["deviceKey"],
    leaseId: params["leaseId"],
    platform: params["platform"],
    serial: params["serial"],
    target: params["target"],
    ttlMs: params["ttlMs"],
    udid: params["udid"],
  };
}

export function commandLeaseId(params: unknown): string | undefined {
  const fields = record(params);
  const meta = record(fields?.["meta"]);
  const flags = record(fields?.["flags"]);
  return leaseIdOf(meta?.["leaseId"] ?? flags?.["leaseId"]);
}

export type ReplyReading =
  | { readonly kind: "success"; readonly result: Record<string, unknown> }
  | {
      readonly kind: "error";
      readonly code: string | undefined;
      readonly reason: string | undefined;
    }
  | { readonly kind: "unusable" };

// why: an allocate counts as a success only when its release scope passes, so the front and the host never disagree on whether it went through.
export function readReply(text: string, call?: CallClass): ReplyReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unusable" };
  }
  const body = record(parsed);
  if (body === undefined || body["jsonrpc"] !== "2.0") return { kind: "unusable" };
  const error = record(body["error"]);
  if (error !== undefined) {
    const data = record(error["data"]);
    const code = data?.["code"];
    const reason = record(data?.["details"])?.["reason"];
    return {
      code: typeof code === "string" ? code : undefined,
      kind: "error",
      reason: typeof reason === "string" ? reason : undefined,
    };
  }
  const result = record(body["result"]);
  if (result !== undefined && result["ok"] === true && body["error"] === undefined) {
    if (call === "allocate" && readReleaseScope(result["lease"]) === undefined) {
      return { kind: "unusable" };
    }
    return { kind: "success", result };
  }
  return { kind: "unusable" };
}

const LEASE_GONE_REASONS = new Set(["LEASE_NOT_FOUND", "LEASE_EXPIRED", "LEASE_REVOKED"]);

export function leaseGoneReason(reading: ReplyReading): string | undefined {
  return reading.kind === "error" &&
    reading.code === "UNAUTHORIZED" &&
    reading.reason !== undefined &&
    LEASE_GONE_REASONS.has(reading.reason)
    ? reading.reason
    : undefined;
}
