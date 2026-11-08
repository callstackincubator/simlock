import { FRONT_PREFIX } from "./paths.js";

export type ReplyCode = "INVALID_ARGS" | "COMMAND_FAILED" | "UNAUTHORIZED";

export interface FrontReply {
  readonly message: string;
  readonly code: ReplyCode;
  readonly status: number;
  readonly details: { readonly reason: string };
  readonly retriable: boolean;
}

export const LEASE_ENDED_MESSAGE = "lease ended by simlock; run disconnect, then open";

/** why: the CLI allocates a new lease only for agent-device's own lease-gone reasons, so this one fails the command and prints the message. */
export function leaseEndedByHost(): FrontReply {
  return {
    code: "UNAUTHORIZED",
    details: { reason: "LEASE_ENDED_BY_HOST" },
    message: LEASE_ENDED_MESSAGE,
    status: 200,
    retriable: false,
  };
}

export function notAvailable(reason: string, retriable = true): FrontReply {
  return {
    code: "COMMAND_FAILED",
    details: { reason: "SIMLOCK_UNAVAILABLE" },
    retriable,
    message: `agent-device is not available on this simlock: ${reason}`,
    status: 503,
  };
}

/** why: the gateway keeps a disconnected worker's lease, so a request for it is answered before it is relayed; `details.reason` lets a caller tell it from agent-device being unavailable. */
export function workerUnreachable(): FrontReply {
  return {
    ...notAvailable("the worker holding this device is not connected to the gateway; try again"),
    details: { reason: "WORKER_UNREACHABLE" },
  };
}

const unreachableAnswers = new WeakSet<Response>();

export function markUnreachableAnswer(response: Response): Response {
  unreachableAnswers.add(response);
  return response;
}

export function isUnreachableAnswer(response: Response): boolean {
  return unreachableAnswers.has(response);
}

export function refusal(message: string, status = 400): FrontReply {
  return {
    code: "INVALID_ARGS",
    details: { reason: "REFUSED_BY_SIMLOCK" },
    retriable: false,
    message,
    status,
  };
}

export function failure(message: string, status = 502, retriable = false): FrontReply {
  return {
    code: "COMMAND_FAILED",
    details: { reason: status === 504 ? "NO_DEVICE_IN_TIME" : "SIMLOCK_FAILED" },
    retriable: status === 504 || retriable,
    message,
    status,
  };
}

export function successReply(data: unknown, rpc: { readonly id: unknown }): Response {
  return Response.json({ id: rpc.id, jsonrpc: "2.0", result: { data, ok: true } });
}

export function frontReply(reply: FrontReply, rpc: { readonly id: unknown } | undefined): Response {
  if (rpc === undefined) {
    return Response.json(
      {
        code: reply.code,
        error: reply.message,
        ok: false,
        reason: reply.details.reason,
        retriable: reply.retriable,
      },
      { status: reply.status },
    );
  }
  return Response.json(
    {
      error: {
        code: -32000,
        data: {
          code: reply.code,
          ...(reply.details === undefined ? {} : { details: reply.details }),
          message: reply.message,
          retriable: reply.retriable,
        },
        message: reply.message,
      },
      id: rpc.id,
      jsonrpc: "2.0",
    },
    { status: reply.status },
  );
}

// why: a reply made for a request the front did not read itself answers a JSON-RPC call under that call's id, and any other request in the flat shape.
export async function frontReplyFor(request: Request, reply: FrontReply): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== `${FRONT_PREFIX}/rpc`) {
    return frontReply(reply, undefined);
  }
  try {
    const body: unknown = await request.clone().json();
    const id = typeof body === "object" && body !== null && "id" in body ? body.id : null;
    return frontReply(reply, { id });
  } catch {
    return frontReply(reply, { id: null });
  }
}
