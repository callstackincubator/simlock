import type { Identity } from "../../auth/index.js";
import { LEASE_HEADER } from "../shared/paths.js";
import { asRecord } from "../shared/selectors.js";
import { exchange, leaseCall, listLeases, type FrontContext } from "./context.js";
import type { HeldView } from "./front-map.js";

export type TokenDevice = HeldView & { readonly leaseId: string };

export class LeaseCheckFailed extends Error {
  constructor() {
    super("could not check your leases; try again");
  }
}

export async function tokenDevices(
  context: FrontContext,
  identity: Identity,
): Promise<readonly TokenDevice[]> {
  const held = context.map.liveOf(identity.principal);
  if (held.length === 0) return held;
  let listed: Awaited<ReturnType<typeof listLeases>>;
  try {
    listed = await listLeases(context, identity);
  } catch {
    throw new LeaseCheckFailed();
  }
  for (const entry of held) {
    if (listed.some((lease) => lease.id === entry.leaseId)) continue;
    if (context.link.stillHeld?.(entry.leaseId) !== true) context.map.markEnded(entry.leaseId);
  }
  return context.map
    .liveOf(identity.principal)
    .filter((entry) => listed.some((lease) => lease.id === entry.leaseId));
}

// why: agent-device's allocate reply names no device, and it matches `--device` against the session's device by name alone, so each lease's name is read once from its device list, when a rule first needs it.
export async function namedTokenDevices(
  context: FrontContext,
  identity: Identity,
  request: Request,
): Promise<readonly TokenDevice[]> {
  const held = await tokenDevices(context, identity);
  let learned = false;
  for (const device of held) {
    if (device.name !== undefined || device.named === true) continue;
    const reading = await inventoryOf(context, identity, request, device);
    if (reading === undefined) continue;
    context.map.setName(device.leaseId, reading.name);
    learned = true;
  }
  return learned
    ? context.map
        .liveOf(identity.principal)
        .filter((entry) => held.some((h) => h.leaseId === entry.leaseId))
    : held;
}

async function inventoryOf(
  context: FrontContext,
  identity: Identity,
  request: Request,
  device: TokenDevice,
): Promise<{ readonly name: string | undefined } | undefined> {
  const headers = leaseCall(request, "agent_device.lease.allocate", {}, null).headers;
  headers.set(LEASE_HEADER, device.leaseId);
  const listing = new Request(request.url, {
    body: JSON.stringify({
      id: null,
      jsonrpc: "2.0",
      method: "agent_device.command",
      params: { command: "devices", meta: { leaseId: device.leaseId } },
    }),
    headers,
    method: "POST",
  });
  const reply = await exchange(context, listing, identity, "command", device.leaseId);
  if (reply.reading.kind !== "success") return undefined;
  const devices = asRecord(reply.reading.result["data"])?.["devices"];
  if (!Array.isArray(devices)) return undefined;
  const own = devices.map(asRecord).find((entry) => String(entry?.["id"]) === device.address);
  return { name: typeof own?.["name"] === "string" ? own["name"] : undefined };
}
