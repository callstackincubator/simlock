import type { SimlockAdminClient } from "../admin/index.js";
import { reconnectWhileWaiting } from "../lease-policy/index.js";
import { connectDaemonClient } from "./connect.js";
import type { CliEnvironment } from "./types.js";

// why: the CLI's half of `reconnectWhileWaiting`: the new connection is a daemon client, closed when the wait ended before it opened.
export function reconnectToFarm(options: {
  readonly environment: CliEnvironment;
  readonly token: string | undefined;
  readonly origin: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}): Promise<SimlockAdminClient> {
  const { environment, token, origin, deadline, signal } = options;
  return reconnectWhileWaiting({
    abandon: (client) => void client.close().catch(() => undefined),
    attempt: () => connectDaemonClient(environment, token),
    clock: environment.clock,
    deadline,
    origin,
    signal,
  });
}
