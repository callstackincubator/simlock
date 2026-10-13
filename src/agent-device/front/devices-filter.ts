import type { TokenIdentity } from "../../http/token-store.js";
import { failure, frontReply } from "../shared/replies.js";
import { readBounded, readReply } from "../shared/rpc.js";
import { asRecord } from "../shared/selectors.js";
import { relay, type FrontContext } from "./context.js";
import { LeaseCheckFailed, tokenDevices } from "./token-devices.js";

function emptyList(rpc: { readonly id: unknown }): Response {
  return Response.json({
    id: rpc.id,
    jsonrpc: "2.0",
    result: { data: { devices: [] }, ok: true },
  });
}

export async function filterDevices(
  context: FrontContext,
  identity: TokenIdentity,
  response: Response,
  rpc: { readonly id: unknown },
): Promise<Response> {
  const text = await readBounded(response.body);
  if (text === undefined) return emptyList(rpc);
  const reading = readReply(text);
  if (reading.kind === "error") return relay({ response, text });
  const devices = asRecord(reading.kind === "success" ? reading.result["data"] : undefined)?.[
    "devices"
  ];
  if (reading.kind !== "success" || !Array.isArray(devices)) return emptyList(rpc);
  if (!devices.every((device) => asRecord(device) !== undefined)) return emptyList(rpc);
  let held: Set<string>;
  try {
    held = new Set((await tokenDevices(context, identity)).map((device) => device.address));
  } catch (error) {
    if (!(error instanceof LeaseCheckFailed)) throw error;
    return frontReply(failure(error.message), rpc);
  }
  const kept = devices.filter((device) => held.has(String(asRecord(device)?.["id"])));
  const body = JSON.parse(text) as { result: { data: Record<string, unknown> } };
  body.result.data["devices"] = kept;
  return relay({ response, text: JSON.stringify(body) });
}

interface GatewayDevices {
  readonly request: Request;
  readonly identity: TokenIdentity;
  readonly read: { readonly id: unknown; readonly text: string };
  readonly forward: (request: Request, leaseId: string) => Promise<Response>;
}

type Piece =
  | {
      readonly kind: "list";
      readonly response: Response;
      readonly text: string;
      readonly devices: unknown[];
    }
  | { readonly kind: "failed"; readonly response: Response };

function unreadable(leaseId: string, rpc: { readonly id: unknown }): Response {
  return frontReply(
    failure(`could not read the device list from the worker holding lease ${leaseId}`),
    rpc,
  );
}

async function readPiece(
  response: Response,
  address: string,
  leaseId: string,
  rpc: { readonly id: unknown },
): Promise<Piece> {
  const text = await readBounded(response.body);
  if (text === undefined) return { kind: "failed", response: unreadable(leaseId, rpc) };
  const reading = readReply(text);
  if (reading.kind === "error") return { kind: "failed", response: relay({ response, text }) };
  const devices = asRecord(reading.kind === "success" ? reading.result["data"] : undefined)?.[
    "devices"
  ];
  if (
    reading.kind !== "success" ||
    !Array.isArray(devices) ||
    !devices.every((device) => asRecord(device) !== undefined)
  ) {
    return { kind: "failed", response: unreadable(leaseId, rpc) };
  }
  const own = devices.filter((device) => String(asRecord(device)?.["id"]) === address);
  return { devices: own, kind: "list", response, text };
}

// why: each worker answers with everything its daemon sees; cutting each answer to its own lease's device before joining keeps two workers' equal ids apart and other tokens' devices out.
export async function devicesThroughGateway(
  context: FrontContext,
  { forward, identity, read, request }: GatewayDevices,
): Promise<Response> {
  let held: Awaited<ReturnType<typeof tokenDevices>>;
  try {
    held = await tokenDevices(context, identity);
  } catch (error) {
    if (!(error instanceof LeaseCheckFailed)) throw error;
    return frontReply(failure(error.message), read);
  }
  if (held.length === 0) return emptyList(read);
  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  const pieces = await Promise.all(
    held.map(async (lease) => {
      const forwarded = new Request(request.url, {
        body: read.text,
        headers: withoutLength(request.headers),
        method: request.method,
        signal,
      });
      let piece: Piece;
      try {
        piece = await readPiece(
          await forward(forwarded, lease.leaseId),
          lease.address,
          lease.leaseId,
          read,
        );
      } catch {
        piece = { kind: "failed", response: unreadable(lease.leaseId, read) };
      }
      const cancelledByUs = piece.kind === "failed" && cancel.signal.aborted;
      if (piece.kind === "failed") cancel.abort();
      return { cancelledByUs, piece };
    }),
  );
  const failed = pieces.find((entry) => entry.piece.kind === "failed" && !entry.cancelledByUs);
  if (failed !== undefined) return (failed.piece as { response: Response }).response;
  const lists = pieces.flatMap((entry) => (entry.piece.kind === "list" ? [entry.piece] : []));
  const [firstList] = lists;
  if (firstList === undefined) return emptyList(read);
  const body = JSON.parse(firstList.text) as { result: { data: Record<string, unknown> } };
  body.result.data["devices"] = lists.flatMap((entry) => entry.devices);
  return relay({ response: firstList.response, text: JSON.stringify(body) });
}

function withoutLength(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  return headers;
}
