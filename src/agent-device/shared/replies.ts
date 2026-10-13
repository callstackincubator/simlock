import { FRONT_PREFIX } from "./paths.js";

export type ReplyCode = "INVALID_ARGS" | "COMMAND_FAILED" | "UNAUTHORIZED";

export interface FrontReply {
  readonly message: string;
  readonly code: ReplyCode;
  readonly status: number;
  readonly details?: { readonly reason: string };
}

const LEASE_ENDED_MESSAGE = "lease ended by simlock; run disconnect, then open";

/** why: the CLI allocates a new lease only for agent-device's own lease-gone reasons, so this one fails the command and prints the message. */
export function leaseEndedByHost(): FrontReply {
  return {
    code: "UNAUTHORIZED",
    details: { reason: "LEASE_ENDED_BY_HOST" },
    message: LEASE_ENDED_MESSAGE,
    status: 200,
  };
}

export function notAvailable(reason: string): FrontReply {
  return {
    code: "COMMAND_FAILED",
    message: `agent-device is not available on this simlock: ${reason}`,
    status: 503,
  };
}

export function refusal(message: string, status = 400): FrontReply {
  return { code: "INVALID_ARGS", message, status };
}

export function failure(message: string, status = 502): FrontReply {
  return { code: "COMMAND_FAILED", message, status };
}

export function frontReply(reply: FrontReply, rpc: { readonly id: unknown } | undefined): Response {
  if (rpc === undefined) {
    return Response.json(
      { code: reply.code, error: reply.message, ok: false },
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
