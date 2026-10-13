export interface ReleaseScope {
  readonly tenantId: string;
  readonly runId: string;
  readonly leaseProvider?: string;
  readonly clientId?: string;
  readonly deviceKey?: string;
}

const SCOPE_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
const OPTIONAL_KEYS = ["leaseProvider", "clientId", "deviceKey"] as const;

function validScopeValue(value: unknown): value is string {
  return typeof value === "string" && SCOPE_VALUE.test(value);
}

// why: agent-device's own device keys look like `ios:mobile:<id>`, so only the length is bounded.
export function validDeviceKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

export function readReleaseScope(lease: unknown): ReleaseScope | undefined {
  if (typeof lease !== "object" || lease === null || Array.isArray(lease)) return undefined;
  const fields = lease as Record<string, unknown>;
  const tenantId = fields["tenantId"];
  const runId = fields["runId"];
  if (!validScopeValue(tenantId) || !validScopeValue(runId)) return undefined;
  const optional: { -readonly [K in (typeof OPTIONAL_KEYS)[number]]?: string } = {};
  for (const key of OPTIONAL_KEYS) {
    const value = fields[key];
    if (key === "deviceKey") {
      if (validDeviceKey(value)) optional[key] = value;
      continue;
    }
    if (value === undefined) continue;
    if (!validScopeValue(value)) return undefined;
    optional[key] = value;
  }
  return { ...optional, runId, tenantId };
}
