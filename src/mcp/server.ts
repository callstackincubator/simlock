import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
import { McpSession, toMcpErrorResult } from "./session.js";

const SERVER_INFO = { name: "pitlane", version: "1.0.0" };

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
        const output = await session.lease(input, extra.signal);
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
