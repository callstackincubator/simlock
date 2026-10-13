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
