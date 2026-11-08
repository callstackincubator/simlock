import { createHash } from "node:crypto";

// why: agent-device accepts a tenant of 1 to 128 letters, digits, dots, underscores and hyphens.
const MAX_TENANT_CHARS = 128;
const HASH_CHARS = 27;

// why: a character agent-device refuses (or a dot, the separator) becomes `_<hex>_`, so two names never share a tenant.
function tenantPart(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/gu, (char) => `_${char.codePointAt(0)?.toString(16)}_`);
}

// why: cut to 128 characters with a hash of the whole name when longer, so every input gives a tenant agent-device accepts and distinct inputs stay distinct.
function boundedTenant(parts: readonly string[]): string {
  const tenant = parts.map(tenantPart).join(".");
  if (tenant.length <= MAX_TENANT_CHARS) return tenant;
  const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${tenant.slice(0, MAX_TENANT_CHARS - HASH_CHARS - 1)}.${hash.slice(0, HASH_CHARS)}`;
}

// why: a worker's call names the lease it belongs to, so each lease's sessions, uploads and artifacts are its own; a call with no lease keeps the principal's tenant.
export function workerTenant(principal: string, leaseId: string | undefined): string {
  return leaseId === undefined ? principal : boundedTenant([principal, leaseId]);
}

// why: `gw.<gateway instance id>.<principal>[.<lease id>]`; the worker takes it as it is.
export function relayTenant(
  instanceId: string,
  principal: string,
  leaseId: string | undefined,
): string {
  return boundedTenant(
    leaseId === undefined ? ["gw", instanceId, principal] : ["gw", instanceId, principal, leaseId],
  );
}
