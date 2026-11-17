import {
  awaitWithin,
  RELEASE_TIMEOUT_MS,
  startLeaseRenewal,
  startReconnect,
  type LeaseRenewal,
  type Reconnect,
} from "../../lease-policy/index.js";
import { ERROR_TABLE, LEASE_LOST_EXIT_CODE } from "../../contract/index.js";
import type { LeaseGrant, SimlockAdminClient } from "../../admin/index.js";
import type { DeviceClass, Role } from "../../contract/index.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, requiredPositional, UsageError, withHelpHint, writeResult } from "../args.js";
import { parseDuration } from "../duration.js";
import { writeError } from "../errors.js";
import { waitForTermination } from "../termination.js";
import type { CommandContext } from "../tree.js";

/**
 * why: A key that is safe to the left of `=` in a shell `export`. Anything else is a command
 * waiting for `eval` to run it, and escaping the value alone defends the half an attacker
 * does not need. Not reachable through the shipped drivers (their keys are literals), but
 * `SIMLOCK_DRIVERS_MODULE` and the wire both accept whatever a driver returns.
 */
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  if (context.path[1] === "renew") return runRenew(argv, context);
  return runLease(argv, context);
}

function parseBindPid(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const pid = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(pid) || pid <= 0)
    throw new UsageError("lease --bind-pid must be a positive integer");
  return pid;
}

/** why: the key is the text before the first `=` and the value everything after it; a repeated key keeps the last value. */
function parseMeta(flags: unknown): Record<string, string> | undefined {
  if (!Array.isArray(flags)) return undefined;
  const metadata: Record<string, string> = {};
  for (const flag of flags as string[]) {
    const at = flag.indexOf("=");
    if (at < 0) throw new UsageError(`--meta needs key=value (got ${flag})`);
    metadata[flag.slice(0, at)] = flag.slice(at + 1);
  }
  return metadata;
}

// fallow-ignore-next-line complexity -- CLI command parsing remains intentionally local to its rendering boundary.
async function runLease(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    "agent-id": { type: "string" },
    "allow-download": { type: "boolean" },
    baseline: { type: "string" },
    "bind-pid": { type: "string" },
    class: { type: "string" },
    detach: { type: "boolean" },
    device: { type: "string" },
    "export-env": { type: "boolean" },
    except: { type: "string" },
    help: { type: "boolean", short: "h" },
    "image-tag": { type: "string" },
    "lease-id": { type: "string" },
    meta: { type: "string", multiple: true },
    mode: { type: "string" },
    "no-wait": { type: "boolean" },
    os: { type: "string" },
    physical: { type: "boolean" },
    platform: { type: "string" },
    timeout: { type: "string" },
    ttl: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock lease --platform <ios|android> [--device <model> | --class <class>]\n" +
        "                     [--os <version|range>] [--mode <slim|full>] [--image-tag <tag>] [--agent-id <id>]\n" +
        "                     [--except <category,...>] [--baseline <name>]\n" +
        "                     [--timeout <duration>] [--lease-id <id>] [--physical]\n" +
        "                     [--no-wait] [--detach] [--ttl <duration>] [--allow-download]\n" +
        "                     [--meta <key=value>]... [--export-env] [--bind-pid <pid>]\n",
    );
    return 0;
  }
  if (values.platform !== "ios" && values.platform !== "android")
    throw new UsageError(withHelpHint("lease requires --platform <ios|android>"));
  const platform = values.platform as "ios" | "android";
  const metadata = parseMeta(values.meta);
  const baseline =
    typeof values.baseline === "string"
      ? values.baseline
      : environment.baselineFromEnv === "" || environment.baselineFromEnv === undefined
        ? undefined
        : environment.baselineFromEnv;
  if (values.device === "") throw new UsageError("lease --device must not be empty");
  if (values.class === "") throw new UsageError("lease --class must not be empty");
  if (values["agent-id"] === "") throw new UsageError("lease --agent-id must not be empty");
  const requesterId = (values["agent-id"] as string | undefined) ?? environment.requesterId;
  if (
    environment.remote !== undefined &&
    values["agent-id"] === undefined &&
    environment.requesterIsProcess === true
  ) {
    environment.stderr.write(
      `${JSON.stringify({ notice: `no SIMLOCK_AGENT_ID or agent session: this lease's requester is ${requesterId}, this process; set SIMLOCK_AGENT_ID, or pass --lease <lease id>, for later commands to find it` })}\n`,
    );
  }
  const detached = values.detach ?? false;
  const timeoutMs = typeof values.timeout === "string" ? parseDuration(values.timeout) : undefined;
  const ttlMs = typeof values.ttl === "string" ? parseDuration(values.ttl) : undefined;
  // why: A reparented holder keeps renewing, so a TTL cannot bound it; watching the parent does.
  const bindPid = parseBindPid(values["bind-pid"]);
  const watchedPid = bindPid ?? environment.parentPid;
  const termination = detached
    ? undefined
    : waitForTermination(environment.signals, environment.parentWatch, watchedPid);

  let ourLeaseId: string | undefined;
  // why: A signal or a dead --bind-pid process while it connects or the request waits must leave the queue at
  // once, as the client's abort does; noticed only at grant time, the device would be taken and
  // released, and a killed process would leave its request queued.
  const waitAbort = new AbortController();
  let cancelledWhileWaiting = false;
  void termination?.settled.then(() => {
    if (ourLeaseId !== undefined) return;
    cancelledWhileWaiting = true;
    waitAbort.abort();
  });
  let client = await connectDaemonClient(environment, token);
  // why: the farm's origin is what a reconnect notice names; it was checked when the connection was made.
  const farmOrigin =
    environment.remote === undefined
      ? undefined
      : (await import("../../simlock-client/farm-url.js")).checkedFarmUrl(
          environment.remote.url,
          "--url",
        );
  let leaseLost = false;
  let ourLeaseDeadline: number | undefined;
  let notifyLeaseLost: (() => void) | undefined;
  const leaseLostSignal = new Promise<void>((resolve) => {
    notifyLeaseLost = resolve;
  });
  let wroteLeaseLost = false;
  const markLeaseLost = (notice: {
    readonly deviceId: string;
    readonly leaseId: string;
    readonly reason: string;
  }): void => {
    if (!wroteLeaseLost) {
      wroteLeaseLost = true;
      environment.stderr.write(`${JSON.stringify({ push: "lease-lost", ...notice })}\n`);
    }
    leaseLost = true;
    notifyLeaseLost?.();
  };
  let connectionLost = false;
  let notifyConnectionLost: (() => void) | undefined;
  const connectionLostSignal = new Promise<void>((resolve) => {
    notifyConnectionLost = resolve;
  });
  // why: set once a held remote lease is granted: a drop then starts the reconnect instead of ending the command.
  let onDropped: (() => void) | undefined;
  const subscribe = (target: SimlockAdminClient): (() => void) => {
    const offLeaseLost = target.onLeaseLost((push) => {
      if (push.leaseId !== ourLeaseId) return;
      markLeaseLost(push);
    });
    const offConnectionLost = target.onConnectionLost(() => {
      if (onDropped !== undefined) {
        onDropped();
        return;
      }
      connectionLost = true;
      if (ourLeaseId !== undefined) {
        environment.stderr.write(
          `${JSON.stringify({
            error: {
              code: "DAEMON_CONNECTION_LOST",
              message: `lost the daemon connection; lease ${ourLeaseId} is still yours until its ttlDeadline ${String(ourLeaseDeadline)} -- renew it with \`simlock lease renew ${ourLeaseId}\` or let it expire`,
            },
          })}\n`,
        );
      }
      notifyConnectionLost?.();
    });
    const offUnhealthy = target.onDeviceUnhealthy((push) => {
      environment.stderr.write(`${JSON.stringify({ push: "device-unhealthy", ...push })}\n`);
    });
    const offRecovered = target.onDeviceRecovered((push) => {
      environment.stderr.write(`${JSON.stringify({ push: "device-recovered", ...push })}\n`);
    });
    return () => {
      offLeaseLost();
      offUnhealthy();
      offRecovered();
      offConnectionLost();
    };
  };
  let unsubscribe = subscribe(client);
  let heldLeaseId: string | undefined;
  // why: stderr lines keep the order their causes happened in even though each write waits on
  // the lazy error-code lookup: every async error write joins this chain, and the command's
  // last `await` is the chain's tail, so the lines are on the wire before this process exits.
  let stderrWrites: Promise<void> = Promise.resolve();
  const queueErrorWrite = (error: unknown): void => {
    // why: a write that fails (a closed pipe, say) is swallowed like the base's synchronous
    // write was: the release is awaited ahead of the chain in the `finally` below, but a
    // rejected chain still skips the dispose, the unsubscribes and the close after it.
    stderrWrites = stderrWrites
      .then(() => writeError((value) => environment.stderr.write(value), error))
      .catch(() => undefined);
  };
  const releaseHeldLease = async (): Promise<void> => {
    // why: A dead connection can neither carry the release nor needs it: the lease outlives this
    // process either way, and `client.releaseLease` would only reject `DAEMON_CONNECTION_LOST`
    // a second time.
    if (heldLeaseId === undefined || leaseLost || connectionLost) return;
    const leaseId = heldLeaseId;
    heldLeaseId = undefined;
    try {
      // why: Bounded like MCP's farewell release: a daemon that accepts the frame and never answers
      // must not leave `simlock lease` hanging after a Ctrl-C.
      await awaitWithin(
        environment.clock,
        RELEASE_TIMEOUT_MS,
        client.releaseLease({ leaseId }),
        `Timed out releasing lease ${leaseId}`,
      );
    } catch (error: unknown) {
      queueErrorWrite(error);
    }
  };
  let renewal: LeaseRenewal | undefined;
  let reconnect: Reconnect | undefined;
  try {
    let grant: LeaseGrant;
    try {
      grant = await client.requestLease(
        {
          allowDownload: values["allow-download"] === true,
          noWait: values["no-wait"] === true,
          requesterId,
          ...(typeof values.device === "string" ? { model: values.device } : {}),
          ...(typeof values.class === "string" ? { class: values.class as DeviceClass } : {}),
          ...(typeof values.os === "string" ? { osVersion: values.os } : {}),
          ...(values.physical === true ? { physical: true } : {}),
          platform,
          ...(typeof values.mode === "string" ? { mode: values.mode as "slim" | "full" } : {}),
          ...(typeof values.except === "string" ? { except: values.except.split(",") } : {}),
          ...(typeof values["image-tag"] === "string" ? { imageTag: values["image-tag"] } : {}),
          ...(baseline === undefined ? {} : { baseline }),
          ...(typeof values["lease-id"] === "string" ? { leaseId: values["lease-id"] } : {}),
          ...(metadata === undefined ? {} : { metadata }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(ttlMs === undefined ? {} : { ttlMs }),
        },
        {
          signal: waitAbort.signal,
          onProgress: (progress) => {
            environment.stderr.write(`${JSON.stringify({ push: "progress", ...progress })}\n`);
          },
        },
      );
    } catch (error: unknown) {
      if (cancelledWhileWaiting && (error as { code?: unknown }).code === "CANCELLED") return 0;
      throw error;
    }
    ourLeaseId = grant.lease.id;
    ourLeaseDeadline = grant.lease.ttlDeadline;
    if (!detached) heldLeaseId = grant.lease.id;
    const result = { ...grant, role: client.role };
    if (values["export-env"] === true) writeExportEnv(environment, result);
    else writeResult((value) => environment.stdout.write(value), result);
    if (termination === undefined) return 0;
    if (connectionLost) return ERROR_TABLE.DAEMON_CONNECTION_LOST.cliExitCode;
    const grantedLease = grant.lease;
    const beginRenewal = (ttlMs: number, ttlDeadline: number): void => {
      renewal = startLeaseRenewal({
        clock: environment.clock,
        leaseId: grantedLease.id,
        ttlMs,
        ttlDeadline,
        renew: (leaseId) => client.renewLease({ leaseId }),
        onRenewed: (renewed) => {
          ourLeaseDeadline = renewed.ttlDeadline;
        },
        onError: (error) => {
          if (connectionLost) return;
          queueErrorWrite(error);
        },
        onLeaseGone: (reason, error) => {
          markLeaseLost({ deviceId: grantedLease.deviceId, leaseId: grantedLease.id, reason });
          queueErrorWrite(error);
        },
      });
    };
    if (farmOrigin !== undefined) {
      onDropped = () => {
        renewal?.stop();
        environment.stderr.write(
          `${JSON.stringify({ notice: `lost the connection to ${farmOrigin}; reconnecting until ${new Date(ourLeaseDeadline ?? 0).toISOString()} to keep lease ${grantedLease.id}` })}\n`,
        );
        reconnect = startReconnect({
          clock: environment.clock,
          deadline: ourLeaseDeadline ?? 0,
          onDeadline: () => {
            markLeaseLost({
              deviceId: grantedLease.deviceId,
              leaseId: grantedLease.id,
              reason: "renew-failed",
            });
            queueErrorWrite(
              new Error(
                `Gave up reconnecting to ${farmOrigin}: lease ${grantedLease.id} passed its deadline`,
              ),
            );
          },
          attempt: async () => {
            const next = await connectDaemonClient(environment, token);
            const renewed = await next.renewLease({ leaseId: grantedLease.id });
            unsubscribe();
            const previous = client;
            client = next;
            unsubscribe = subscribe(next);
            await previous.close();
            return renewed;
          },
          onReconnected: (renewed) => {
            ourLeaseDeadline = renewed.ttlDeadline;
            environment.stderr.write(
              `${JSON.stringify({ notice: `reconnected to ${farmOrigin}; lease ${grantedLease.id} renewed` })}\n`,
            );
            beginRenewal(renewed.ttlMs, renewed.ttlDeadline);
          },
        });
      };
    }
    beginRenewal(grant.lease.ttlMs, grant.lease.ttlDeadline);
    await Promise.race([termination.settled, leaseLostSignal, connectionLostSignal]);
    if (leaseLost) return LEASE_LOST_EXIT_CODE;
    if (connectionLost) return ERROR_TABLE.DAEMON_CONNECTION_LOST.cliExitCode;
    return 0;
  } finally {
    // why: Stopped before the release, always: a renew must never race the release of the lease it
    // is renewing, and no timer may outlive this command.
    renewal?.stop();
    reconnect?.stop();
    await releaseHeldLease();
    await stderrWrites;
    termination?.dispose();
    unsubscribe();
    await client.close();
  }
}

async function runRenew(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    ttl: { type: "string" },
  });
  const { positionals } = values;
  if (values.help) {
    environment.stdout.write("Usage: simlock lease renew <lease-id> [--ttl <duration>]\n");
    return 0;
  }
  const leaseId = requiredPositional(positionals, "lease-id");
  const client = await connectDaemonClient(environment, token);
  try {
    writeResult(
      (value) => environment.stdout.write(value),
      await client.renewLease({
        leaseId,
        ...(typeof values.ttl === "string" ? { ttlMs: parseDuration(values.ttl) } : {}),
      }),
    );
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * why: Writes the export lines, and -- when there are none -- one line to stderr saying so.
 * Silence would be worse than it looks: the lease is committed and TTL-bound either way,
 * and a caller that was told neither its id nor that anything was missing can neither
 * renew nor release it, and has no scoping to reach the device with. stdout stays clean so
 * `eval "$(...)"` is unaffected. An older daemon, which sends no `environment` at all, is
 * the case that actually produces this.
 */
function writeExportEnv(
  environment: CommandContext["environment"],
  result: LeaseGrant & { readonly role: Role },
): void {
  environment.stdout.write(exportEnvLines(result.environment));
  if (Object.keys(result.environment).length > 0) return;
  environment.stderr.write(
    `simlock: lease ${result.lease.id} carries no environment, so there is nothing to export and the device may be unreachable from a bare simctl or adb. Release it with \`simlock release ${result.lease.id}\`.\n`,
  );
}

/**
 * why: Shell `export` lines for `eval "$(simlock lease ... --export-env)"`. Single quotes because
 * they are the only shell quoting that takes every byte literally, and `'\''` is the one way
 * to get a literal quote back inside them -- a device-set path is a user-configurable path
 * and may hold a space or an apostrophe. Sorted so repeated runs produce identical output.
 *
 * A key that is not a shell identifier fails the command rather than being skipped: the
 * driver that produced it is broken, and dropping it silently would leave the holder with
 * a lease it cannot reach and no idea why.
 */
function exportEnvLines(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!SHELL_IDENTIFIER.test(key)) {
        throw new Error(
          `Refusing to export ${JSON.stringify(key)}: a lease environment key must be a shell identifier, and this one would change what \`eval\` runs.`,
        );
      }
      return `export ${key}='${value.replaceAll("'", "'\\''")}'\n`;
    })
    .join("");
}

export { run };
