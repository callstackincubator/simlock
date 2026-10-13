export interface ReleaseScope {
  readonly tenantId: string;
  readonly runId: string;
  readonly leaseProvider?: string;
  readonly clientId?: string;
  readonly deviceKey?: string;
}

export function readReleaseScope(_lease: unknown): ReleaseScope | undefined {
  return undefined;
}
