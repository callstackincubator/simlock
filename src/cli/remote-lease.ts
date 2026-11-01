import type { SimlockAdminClient } from "../admin/index.js";
import { UsageError } from "./errors.js";
import type { CommandContext } from "./tree.js";

// why: a caller on another machine has no requester id to filter by, so with no `environment` the errors name the token and `--lease`, and an operator token must name its lease.
export function selectOnlyLease(
  leases: readonly { readonly id: string; readonly requesterId: string }[],
  role: "admin" | "agent",
  environment?: CommandContext["environment"],
): string {
  if (environment === undefined) {
    if (role === "admin") {
      throw new UsageError("An operator token must name its lease: pass --lease <id>");
    }
    if (leases.length === 0) {
      throw new UsageError(
        "This token holds no lease: start one with `simlock lease` on the worker, or pass --lease <id>",
      );
    }
    if (leases.length > 1) {
      throw new UsageError(
        `This token holds more than one lease (${leases.map((lease) => lease.id).join(", ")}); pass --lease <id> to name the device you mean`,
      );
    }
    return (leases[0] as { readonly id: string }).id;
  }
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
