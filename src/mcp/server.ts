import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

import { SimlockError } from "../client/index.js";
import type { Clock, TimerHandle } from "../ports/index.js";
import { describeSchemaIssues } from "../contract/index.js";
import { AGENT_INSTRUCTIONS, MCP_SERVER_INSTRUCTIONS } from "../instructions/index.js";
import {
  leaseSimulatorCheckedInputSchema,
  leaseSimulatorInputSchema,
  leaseSimulatorOutputSchema,
  leaseStatusInputSchema,
  leaseStatusOutputSchema,
  listDevicesInputSchema,
  listDevicesOutputSchema,
  releaseSimulatorInputSchema,
  releaseSimulatorOutputSchema,
  runOnDeviceInputSchema,
  runOnDeviceOutputSchema,
} from "./contracts.js";
import {
  McpSession,
  type DeviceHealthNotice,
  type LeaseProgressNotice,
  toMcpErrorResult,
} from "./session.js";

const SERVER_INFO = { name: "simlock", version: "1.0.0" };

/**
 * Progress is reported on a 4-stage scale (queued / downloading / provisioning-or-reclaiming /
 * booting), each worth 1000 units, so a fresh stage's base always exceeds the previous stage's
 * maximum.
 */
const STAGE_BASE_PROGRESS: Record<LeaseProgressNotice["stage"], number> = {
  booting: 3_000,
  downloading: 1_000,
  provisioning: 2_000,
  queued: 0,
  reclaiming: 2_000,
};
const TOTAL_PROGRESS = 4_000;

const OUTPUT_CAP_CHARACTERS = 32_768;

class TailBuffer {
  text = "";
  lostAny = false;
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  append(chunk: string): void {
    const joined = this.text + chunk;
    if (joined.length > this.#cap) {
      this.lostAny = true;
      this.text = joined.slice(joined.length - this.#cap);
    } else {
      this.text = joined;
    }
  }
}

/** Maps a lease progress push onto an MCP progress notification's `params`. */
function leaseProgressParams(progress: LeaseProgressNotice): {
  readonly message: string;
  readonly progress: number;
} {
  const base = STAGE_BASE_PROGRESS[progress.stage];
  if (progress.stage === "queued") {
    const position = Math.max(progress.queuePosition, 0);
    return {
      message:
        position === 0
          ? "Next in queue"
          : `Queued behind ${position} other request${position === 1 ? "" : "s"}`,
      progress: base + withinStageProgress(position),
    };
  }
  if (progress.stage === "downloading") {
    // A request still behind another download sits at the stage's base; its own download climbs
    // with the installer's percentage, reaching the next stage's base at 100.
    if (progress.waiting) {
      return {
        message: `Waiting for another download before downloading ${progress.component}`,
        progress: base,
      };
    }
    const { percent } = progress;
    return percent === undefined
      ? { message: `Downloading ${progress.component}`, progress: base }
      : {
          message: `Downloading ${progress.component} (${percent}%)`,
          // The contract bounds `percent` to a whole number from 0 to 100.
          progress: base + percent * 10,
        };
  }
  const etaSeconds = Math.max(0, Math.ceil(progress.etaMs / 1_000));
  const verb =
    progress.stage === "provisioning"
      ? "Provisioning"
      : progress.stage === "booting"
        ? "Booting"
        : "Reclaiming";
  return {
    message: `${verb} device (~${etaSeconds}s remaining)`,
    progress: base + withinStageProgress(etaSeconds),
  };
}

/**
 * Climbs toward 1000 as `remaining` (a queue position or an ETA in seconds) shrinks toward 0,
 * staying at or below the next stage's base so stages never overlap.
 */
function withinStageProgress(remaining: number): number {
  return Math.round(1_000 / (Math.max(remaining, 0) + 1));
}

/**
 * Builds a per-lease-request `onProgress` callback that relays daemon progress as
 * `notifications/progress`, clamping so the value MCP requires to increase monotonically never
 * goes backwards even though queue position and ETAs can.
 */
function createLeaseProgressReporter(
  progressToken: string | number,
  sendNotification: (notification: ProgressNotification) => Promise<void>,
): (progress: LeaseProgressNotice) => void {
  let lastProgress = 0;
  return (progress) => {
    const { message, progress: rawProgress } = leaseProgressParams(progress);
    lastProgress = Math.max(rawProgress, lastProgress + 1);
    // Progress is advisory: a transport that went away mid-lease must not surface here as an
    // unhandled rejection and take the server down with it.
    void sendNotification({
      method: "notifications/progress",
      params: { message, progress: lastProgress, progressToken, total: TOTAL_PROGRESS },
    }).catch(() => undefined);
  };
}

const RUN_PROGRESS_MIN_GAP_MS = 1_000;
const RUN_PROGRESS_HEARTBEAT_MS = 10_000;

function createRunProgressReporter(
  clock: Clock,
  progressToken: string | number,
  sendNotification: (notification: ProgressNotification) => Promise<void>,
  message: string,
): { readonly onOutput: () => void; readonly stop: () => void } {
  let sent = 0;
  let lastSentAt: number | undefined;
  let heartbeat: TimerHandle | undefined;
  const send = (): void => {
    sent += 1;
    lastSentAt = clock.now();
    if (heartbeat !== undefined) clock.cancel(heartbeat);
    heartbeat = clock.setTimer(RUN_PROGRESS_HEARTBEAT_MS, send);
    // why: progress is advisory -- a transport that went away mid-command must not surface here
    // as an unhandled rejection.
    void sendNotification({
      method: "notifications/progress",
      params: { message, progress: sent, progressToken },
    }).catch(() => undefined);
  };
  heartbeat = clock.setTimer(RUN_PROGRESS_HEARTBEAT_MS, send);
  return {
    onOutput: () => {
      if (lastSentAt === undefined || clock.now() - lastSentAt >= RUN_PROGRESS_MIN_GAP_MS) send();
    },
    stop: () => {
      if (heartbeat !== undefined) clock.cancel(heartbeat);
      heartbeat = undefined;
    },
  };
}

/** Creates the MCP tool surface for one lease-owning session. */
export function createMcpServer(
  session: McpSession,
  options: { readonly clock: Clock },
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { logging: {} },
    instructions: MCP_SERVER_INSTRUCTIONS,
  });

  server.registerResource(
    "instructions",
    "simlock://instructions",
    {
      title: "Rules for using Simlock",
      description: "The full rules for using Simlock: the CLI, agent-device, iOS builds and MCP.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AGENT_INSTRUCTIONS }],
    }),
  );

  server.registerTool(
    "lease_simulator",
    {
      title: "Lease simulator",
      description:
        "Lease one simulator or emulator for this MCP session. Name an exact model (`model`), or a device class (`class`: phone, tablet, watch, tv, vision, auto or desktop), or name neither to get a phone; naming both is an error. A class or no-model request is served by a fitting idle device before a new one is created. The lease is held until released or this MCP connection closes; provisioning can block unless noWait is true. `osVersion` is an exact version (`18.4`) or a range: `>=`, `>`, `<=` or `<` followed by a version, joined by single spaces (`>=18 <26`), or a hyphen range (`18 - 26`); a range is served by a fitting device or the newest installed runtime in it, and never downloads. Downloads are disabled by default and require allowDownload: true. On Android, imageTag picks the system image type (a tag from list_devices' images, such as google_apis_playstore); a request with imageTag uses only an installed image and never downloads. Pass `leaseId` to choose the lease's ID instead of getting one generated: 1 to 64 ASCII letters, digits, `-` or `_`, starting with a letter or digit; you keep it unique for all time, and an ID that an active lease or a waiting request already holds is refused with LEASE_ID_TAKEN.",
      inputSchema: leaseSimulatorInputSchema,
      outputSchema: leaseSimulatorOutputSchema,
    },
    async (input, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const onProgress =
          progressToken === undefined
            ? undefined
            : createLeaseProgressReporter(progressToken, extra.sendNotification);
        const checked = leaseSimulatorCheckedInputSchema.safeParse(input);
        if (!checked.success) {
          throw new SimlockError(
            "BAD_REQUEST",
            "protocol",
            describeSchemaIssues(checked.error.issues),
            {},
          );
        }
        const output = await session.lease(checked.data, extra.signal, onProgress);
        return success(output);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description:
        "List resolvable device models and installed runtimes per available platform, marking each platform's default runtime (the newest installed). modelRuntimes gives, for each model, the installed runtimes it pairs with; pick a model and os from it, since a listed model and a listed runtime do not always pair. modelAliases gives other names a model answers to (on Android, the device profile id); modelClasses gives the class of each model whose tooling reports one (phone, tablet, watch, tv, vision, auto or desktop); classDefaults gives, per class, the model Simlock would create for it on this host; images lists Android's installed system images with API level, tag, and ABI. Read-only: never downloads a runtime or system image. Call this once to pick a valid device/os combination before lease_simulator, instead of guessing.",
      inputSchema: listDevicesInputSchema,
      outputSchema: listDevicesOutputSchema,
    },
    async (input) => {
      try {
        const output = await session.listDevices(input);
        return success(output);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "release_simulator",
    {
      title: "Release simulator",
      description:
        "Release the simulator lease owned by this MCP session. A session can release only its own held lease. Returns as soon as the lease is given up: wiping the device runs in the background afterwards, so there is nothing to wait for and you can move straight on to other work. The device is not leasable again until that wipe finishes.",
      inputSchema: releaseSimulatorInputSchema,
      outputSchema: releaseSimulatorOutputSchema,
    },
    async (input) => {
      try {
        const output = await session.release(input);
        return success(output);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "lease_status",
    {
      title: "Lease status",
      description:
        "Report this MCP session's current lease, or an explicit no-lease result if it holds nothing. Read-only, small, and safe to call repeatedly (e.g. after a context compaction).",
      inputSchema: leaseStatusInputSchema,
      outputSchema: leaseStatusOutputSchema,
    },
    async () => {
      try {
        return success(await session.status());
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "run_on_device",
    {
      title: "Run on device",
      description:
        "Run one simctl, adb or devicectl command on this session's leased device, on the machine that holds it. Leave the device out: Simlock fills in the lease's UDID or serial, and refuses a command that names another device. File paths are on that machine. Output is text: stdout and stderr each keep their last 32768 characters, and truncated says when any was cut. A non-zero exitCode is the command's own answer, not a tool error. There is no terminal: a bare adb shell is refused, and an interactive command hangs until the time limit (10 minutes by default) stops it.",
      inputSchema: runOnDeviceInputSchema,
      outputSchema: runOnDeviceOutputSchema,
    },
    async (input, extra) => {
      const progressToken = extra._meta?.progressToken;
      const progress =
        progressToken === undefined
          ? undefined
          : createRunProgressReporter(
              options.clock,
              progressToken,
              extra.sendNotification,
              `Running ${[input.tool, input.args[0]].filter((word) => word !== undefined).join(" ")}`,
            );
      try {
        const stdout = new TailBuffer(OUTPUT_CAP_CHARACTERS);
        const stderr = new TailBuffer(OUTPUT_CAP_CHARACTERS);
        const { exitCode } = await session.runOnDevice(input, (chunk) => {
          (chunk.stream === "stdout" ? stdout : stderr).append(chunk.chunk);
          progress?.onOutput();
        });
        return success({
          exitCode,
          stderr: stderr.text,
          stdout: stdout.text,
          truncated: stdout.lostAny || stderr.lostAny,
        });
      } catch (error: unknown) {
        return failure(error);
      } finally {
        progress?.stop();
      }
    },
  );

  session.onLeaseLost((notice) => {
    void server.server.sendLoggingMessage({
      data: {
        deviceId: notice.deviceId,
        leaseId: notice.leaseId,
        message: "Simlock lease ended; this session no longer holds the device.",
        reason: notice.reason,
      },
      level: "warning",
      logger: "simlock",
    });
  });

  session.onDeviceHealth((notice) => {
    void server.server.sendLoggingMessage(deviceHealthLoggingMessage(notice));
  });

  return server;
}

/**
 * Whatever this session had running inside the device (a launched app, a log stream, an
 * Appium/XCUITest session, a port forward) died with the crash and simlock cannot restore it --
 * the lease survives, but the agent still needs to know its in-device state is gone.
 */
function deviceHealthLoggingMessage(notice: DeviceHealthNotice): {
  readonly data: Record<string, unknown>;
  readonly level: "info" | "warning";
  readonly logger: "simlock";
} {
  if (notice.kind === "unhealthy") {
    return {
      data: {
        deviceId: notice.deviceId,
        leaseId: notice.leaseId,
        message:
          "Simlock's device crashed outside simlock; anything running inside it (apps, log streams, automation sessions, port forwards) is gone. Recovery is in progress under the same lease.",
        reason: notice.reason,
      },
      level: "warning",
      logger: "simlock",
    };
  }
  return {
    data: {
      attempts: notice.attempts,
      deviceId: notice.deviceId,
      leaseId: notice.leaseId,
      message: "Simlock's device was rebooted and is ready again under the same lease.",
    },
    level: "info",
    logger: "simlock",
  };
}

function success(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const result = toMcpErrorResult(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: true,
  };
}
