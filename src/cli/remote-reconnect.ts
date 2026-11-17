import type { SimlockAdminClient } from "../admin/index.js";
import { SimlockError } from "../contract/index.js";
import { startReconnect } from "../lease-policy/index.js";
import { connectDaemonClient } from "./connect.js";
import type { CliEnvironment } from "./types.js";

// why: ADR 0081 §4: a queued request is waited for as long as its timeout says, but a farm that stays out of reach this long is gone, and a caller with no timeout would otherwise wait for ever.
export const UNREACHABLE_GIVE_UP_MS = 300_000;

// why: the reconnect of a command that holds no lease yet resolves with the new connection, for the caller to send its request again on; the abort is the caller's Ctrl-C, which ends the wait as a cancelled request.
export function reconnectToFarm(options: {
  readonly environment: CliEnvironment;
  readonly token: string | undefined;
  readonly origin: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<SimlockAdminClient> {
  const { environment, token, origin, deadline, signal } = options;
  return new Promise<SimlockAdminClient>((resolve, reject) => {
    const reconnect = startReconnect({
      attempt: () => connectDaemonClient(environment, token),
      clock: environment.clock,
      deadline,
      onDeadline: () => {
        reject(
          new SimlockError("REMOTE_UNREACHABLE", "transport", `${origin} stayed out of reach`, {
            url: origin,
          }),
        );
      },
      onLeaseGone: reject,
      onReconnected: resolve,
      onRefused: reject,
    });
    signal.addEventListener(
      "abort",
      () => {
        reconnect.stop();
        reject(new SimlockError("CANCELLED", "domain", "Lease request was cancelled", {}));
      },
      { once: true },
    );
  });
}
