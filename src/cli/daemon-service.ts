import { asDaemonRefusal } from "./errors.js";
import { connectDaemonClient } from "./connect.js";
import type { CliEnvironment } from "./types.js";

const STOP_LIMIT_MS = 300_000;
const STOP_POLL_MS = 100;

/** why: install and uninstall change the service under a daemon that would otherwise keep the old
 * one's files open; a clean stop keeps the leases, and the wait is bounded (architecture rule 11).
 * A stopping daemon refuses new connections while it still holds its socket, so the wait ends when
 * the socket is released, not when a connection is refused. */
export async function stopRunningDaemon(
  environment: CliEnvironment,
  token: string | undefined,
): Promise<boolean> {
  let client;
  try {
    client = await connectDaemonClient(environment, token, { launch: false });
  } catch (error: unknown) {
    if ((await asDaemonRefusal(error)) !== undefined) throw error;
    return false;
  }
  try {
    await client.stopDaemon();
  } finally {
    await client.close();
  }
  const deadline = environment.clock.now() + STOP_LIMIT_MS;
  while (await environment.daemonEndpointPresent()) {
    if (environment.clock.now() >= deadline) {
      const { SimlockError } = await import("../contract/index.js");
      throw new SimlockError(
        "SERVICE_FAILED",
        "domain",
        "The running daemon did not stop within 300 s; nothing was changed.",
        {},
      );
    }
    await environment.sleep(STOP_POLL_MS);
  }
  return true;
}
