import { messageOf } from "./errors.js";

export interface Renewal {
  readonly leaseId: string;
  readonly ttlMs: number;
  readonly log: (line: string) => void;
  renew(): Promise<unknown>;
}

function endedByFarm(error: unknown): boolean {
  const details = (error as { details?: { reason?: unknown } } | null)?.details;
  return details?.reason === "LEASE_ENDED_BY_HOST";
}

export function startRenewal(on: Renewal): () => void {
  const timer = setInterval(
    () => {
      on.renew().catch((error: unknown) => {
        if (endedByFarm(error)) {
          clearInterval(timer);
          on.log(
            `simlock: lease ${on.leaseId} was ended by the farm; failures on its device are infrastructure, not tests`,
          );
          return;
        }
        on.log(`simlock: renewing lease ${on.leaseId} failed: ${messageOf(error)}`);
      });
    },
    Math.floor(on.ttlMs / 3),
  );
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
