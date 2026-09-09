/**
 * MCP's connection-lifecycle-only auto-launch (ADR 0003 §11: MCP keeps "connection lifecycle
 * (lazy reconnect, tool-call serialization)"). `simlock/client`'s `connectSimlock` deliberately
 * does not start the daemon itself -- it only ever connects to an already-listening socket
 * (ADR §10: the client "does not reconnect and does not retry"). MCP is the one frontend spawned
 * with no separate "start the daemon first" step, so it is the frontend that needs this. The
 * launch-then-retry policy lives here, next to its one caller, rather than inside the typed
 * client: ADR §10 keeps the client to a single connection that never reconnects, and auto-start
 * is precisely the kind of frontend concern it pushes back out.
 */
import {
  connectSimlock,
  isSimlockError,
  SimlockError,
  type SimlockClient,
} from "../client/index.js";
import { IpcError, type Clock, type DaemonLauncher, type IpcConnector } from "../ports/index.js";

/** What it takes to reach a daemon that is already listening -- no launcher anywhere in it,
 * which is the whole point of the type existing separately. The `heartbeat` option that used
 * to sit here is gone with the daemon's push (ADR 0004 §4). */
export interface ConnectToRunningDaemonOptions {
  readonly ipc: IpcConnector;
  readonly principal: string;
  readonly socketPath: string;
}

export interface ConnectWithAutoLaunchOptions extends ConnectToRunningDaemonOptions {
  readonly clock: Clock;
  readonly launcher: DaemonLauncher;
  readonly retryIntervalMs?: number;
  readonly startupTimeoutMs?: number;
}

/**
 * Connects to the daemon, launching it first if nothing is listening yet. Never launches on
 * any other failure -- a version mismatch or a refused handshake is not "nothing is running",
 * and launching there would risk starting a second daemon instance or masking a real
 * incompatibility (mirrors `DaemonStartupCoordinator#isUnavailable`'s reasoning: "the client
 * never restarts the daemon on mismatch", ADR §6).
 */
export async function connectWithAutoLaunch(
  options: ConnectWithAutoLaunchOptions,
): Promise<SimlockClient> {
  try {
    return await connectToRunningDaemon(options);
  } catch (error: unknown) {
    if (!isUnavailable(error)) throw error;
  }
  await options.launcher.launch();
  const deadline = options.clock.now() + (options.startupTimeoutMs ?? 5_000);
  let lastError: unknown;
  while (options.clock.now() < deadline) {
    try {
      return await connectToRunningDaemon(options);
    } catch (error: unknown) {
      if (!isUnavailable(error)) throw error;
      lastError = error;
      await delay(options.clock, options.retryIntervalMs ?? 50);
    }
  }
  throw new SimlockError(
    "DAEMON_STARTUP_FAILED",
    "transport",
    `Timed out starting simlock daemon: ${errorMessage(lastError)}`,
    {},
  );
}

/**
 * Connects only to a daemon that is already listening, and never launches one -- which is
 * exactly `connectWithAutoLaunch` minus its one extra power, so the latter is written in terms
 * of this rather than beside it.
 *
 * ADR 0004 §2 gives it a caller of its own: the session's renew timer. An idle session should
 * not lose its lease waiting for a tool call that may never come, but an operator's `simlock
 * daemon stop` must not be undone by that same idle session -- so auto-launch stays a tool-call
 * concern, and a lease held across a stopped daemon expires unless the daemon is back before
 * its deadline.
 */
export function connectToRunningDaemon(
  options: ConnectToRunningDaemonOptions,
): Promise<SimlockClient> {
  return connectSimlock({
    endpoint: options.socketPath,
    ipc: options.ipc,
    principal: options.principal,
  });
}

/** True only for "nothing is listening yet" -- a refused/missing socket. */
function isUnavailable(error: unknown): boolean {
  return (
    error instanceof IpcError &&
    (error.code === "connection-refused" || error.code === "endpoint-not-found")
  );
}

function delay(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(milliseconds, resolve));
}

function errorMessage(error: unknown): string {
  if (isSimlockError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}
