import type { SimlockAdminClient } from "../admin/index.js";
import { UsageError } from "./errors.js";
import type { CommandContext } from "./tree.js";

export function selectOnlyLease(
  leases: readonly { readonly id: string; readonly requesterId: string }[],
  role: "admin" | "agent",
  environment: CommandContext["environment"],
): string {
  const own =
    role === "admin"
      ? leases.filter((lease) => lease.requesterId === environment.requesterId)
      : leases;
  if (own.length === 0) {
    throw new UsageError(
      `No lease is held by ${environment.requesterId}: run \`simlock lease\` first, or set SIMLOCK_AGENT_ID to the id that holds it`,
    );
  }
  if (own.length > 1) {
    throw new UsageError(
      `${environment.requesterId} holds more than one lease (${own.map((lease) => lease.id).join(", ")}); pass --lease <id> to name the device you mean`,
    );
  }
  return (own[0] as { readonly id: string }).id;
}

export async function resolveRemoteLeaseId(
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
): Promise<string> {
  const { leases } = await client.listLeases();
  return selectOnlyLease(leases, client.role, environment);
}
