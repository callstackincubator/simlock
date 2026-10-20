import type { Identity } from "../../auth/index.js";
import { listLeases, type FrontContext } from "./context.js";
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
