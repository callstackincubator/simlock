import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

import {
  leaseSimulatorInputSchema,
  leaseSimulatorOutputSchema,
  leaseStatusInputSchema,
  leaseStatusOutputSchema,
  listDevicesInputSchema,
  listDevicesOutputSchema,
  releaseSimulatorInputSchema,
  releaseSimulatorOutputSchema,
} from "./contracts.js";
import { McpSession, type LeaseProgressNotice, toMcpErrorResult } from "./session.js";

const SERVER_INFO = { name: "pitlane", version: "1.0.0" };

/**
 * Progress is reported on a 3-stage scale (queued / provisioning-or-reclaiming / booting), each
 * worth 1000 units, so a fresh stage's base always exceeds the previous stage's maximum.
 */
const STAGE_BASE_PROGRESS: Record<LeaseProgressNotice["stage"], number> = {
  booting: 2_000,
  provisioning: 1_000,
  queued: 0,
  reclaiming: 1_000,
};
const TOTAL_PROGRESS = 3_000;

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
 * Converges toward (but never reaches) 1000 as `remaining` (a queue position or an ETA in
 * seconds) shrinks toward 0, so it never collides with the next stage's base.
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
    void sendNotification({
      method: "notifications/progress",
      params: { message, progress: lastProgress, progressToken, total: TOTAL_PROGRESS },
    });
  };
}

/** Creates the MCP tool surface for one lease-owning session. */
export function createMcpServer(session: McpSession): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { logging: {} } });

  server.registerTool(
    "lease_simulator",
    {
      title: "Lease simulator",
      description:
        "Lease one simulator or emulator for this MCP session. The lease is held until released or this MCP connection closes; provisioning can block unless no_wait is true. Downloads are disabled by default and require allow_download: true.",
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
        const output = await session.lease(input, extra.signal, onProgress);
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
        "List resolvable device models and installed runtimes per available platform, marking each platform's default runtime (the newest installed). Read-only: never downloads a runtime or system image. Call this once to pick a valid device/os combination before lease_simulator, instead of guessing.",
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
        "Release the simulator lease owned by this MCP session. A session can release only its own held lease.",
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
    () => {
      try {
        return success(session.status());
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  session.onLeaseLost((notice) => {
    void server.server.sendLoggingMessage({
      data: {
        device_id: notice.deviceId,
        lease_id: notice.leaseId,
        message: "Pitlane lease ended; this session no longer holds the device.",
        reason: notice.reason,
      },
      level: "warning",
      logger: "pitlane",
    });
  });

  return server;
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
