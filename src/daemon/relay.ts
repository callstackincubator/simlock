export type RelayTarget = (
  request: Request,
  tenant: string,
  leaseId: string | undefined,
) => Promise<Response>;

export type RelayTargets = Readonly<Record<string, RelayTarget>>;
