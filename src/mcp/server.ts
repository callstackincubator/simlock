import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  leaseSimulatorInputSchema,
  leaseSimulatorOutputSchema,
  releaseSimulatorInputSchema,
  releaseSimulatorOutputSchema,
} from "./contracts.js";
import { McpSession, toMcpErrorResult } from "./session.js";

const SERVER_INFO = { name: "pitlane", version: "1.0.0" };

/** Creates the MCP tool surface for one lease-owning session. */
export function createMcpServer(session: McpSession): McpServer {
  const server = new McpServer(SERVER_INFO);

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
