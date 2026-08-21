import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

interface McpErrorPayload {
  readonly code: string;
  readonly message: string;
}

describe("MCP session semantics", () => {
  it("exercises all four tools, and streams strictly increasing progress with human messages", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
      android: { knownModels: ["Pixel 8"], availableOsVersions: ["34"] },
    });
    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow7-tools" } });

    try {
      const devicesBefore = await mcp.client.callTool({ name: "list_devices", arguments: {} });
      expect(devicesBefore.structuredContent).toMatchObject({
        platforms: expect.arrayContaining([
          expect.objectContaining({ platform: "ios", models: ["iPhone 16"] }),
        ]),
      });

      const statusBefore = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusBefore.structuredContent).toEqual({ held: false });

      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { platform: "ios", device: "iPhone 16", os: "18.4" },
        _meta: { progressToken: "flow7-token" },
      });
      const leased = leaseResult.structuredContent as { lease_id: string; device_id: string };

      const progress = mcp.progressNotifications();
      expect(progress.length, "expected at least one notifications/progress frame").toBeGreaterThan(
        0,
      );
      for (const [index, frame] of progress.entries()) {
        expect(frame.progressToken).toBe("flow7-token");
        expect(typeof frame.message).toBe("string");
        expect((frame.message as string).length).toBeGreaterThan(0);
        if (index > 0) {
          expect(frame.progress).toBeGreaterThan(progress[index - 1]?.progress as number);
        }
      }

      const statusAfter = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusAfter.structuredContent).toMatchObject({
        held: true,
        lease_id: leased.lease_id,
      });

      const released = await mcp.client.callTool({
        name: "release_simulator",
        arguments: { lease_id: leased.lease_id },
      });
      expect(released.structuredContent).toEqual({ lease_id: leased.lease_id, released: true });
    } finally {
      await mcp.close();
    }
  });

  it("relays a force-release from the CLI as a logging warning, then LEASE_NOT_OWNED is a clean tool error, and the server stays usable", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow7-force-release" } });

    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { platform: "ios", device: "iPhone 16", os: "18.4" },
      });
      const leased = leaseResult.structuredContent as { lease_id: string; device_id: string };

      const forceRelease = await env.cli(["release", "--all", "--yes"]);
      expect(forceRelease.code).toBe(0);

      const warning = await mcp.waitForNotification((notification) => {
        if (notification.kind !== "logging") return undefined;
        const data = notification.params.data as
          | { lease_id?: string; device_id?: string; reason?: string }
          | undefined;
        return data?.lease_id === leased.lease_id ? notification.params : undefined;
      });
      expect(warning.logger).toBe("simlock");
      expect(warning.level).toBe("warning");
      // The daemon push carries its own internal registry device id, not the
      // driver-opaque `device_id` (udid) the MCP lease result reports -- only assert
      // it names *a* device, plus the lease id and reason, which do match exactly.
      expect(warning.data).toMatchObject({
        lease_id: leased.lease_id,
        device_id: expect.any(String),
        reason: "explicit",
      });

      const statusAfter = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusAfter.structuredContent).toEqual({ held: false });

      const staleRelease = await mcp.client.callTool({
        name: "release_simulator",
        arguments: { lease_id: leased.lease_id },
      });
      expect(staleRelease.isError).toBe(true);
      const errorPayload = JSON.parse(
        (staleRelease.content as { text: string }[])[0]?.text ?? "{}",
      ) as McpErrorPayload;
      expect(errorPayload.code).toBe("LEASE_NOT_OWNED");

      // Still usable: a clean tool error must not have wedged the session/transport.
      const devices = await mcp.client.callTool({ name: "list_devices", arguments: {} });
      expect(devices.isError).toBeFalsy();
    } finally {
      await mcp.close();
    }
  });

  // Regression for PR #35 ("reconnect the session after a daemon restart"): before
  // that fix, an MCP server whose daemon connection died mid-session would surface
  // the *next* tool call as an opaque INTERNAL error instead of transparently
  // reconnecting.
  it("reconnects after the daemon restarts under a live MCP server process (PR #35)", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow7-restart" } });

    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { platform: "ios", device: "iPhone 16", os: "18.4" },
      });
      const leased = leaseResult.structuredContent as { lease_id: string };

      const lostNotice = mcp.waitForNotification((notification) => {
        if (notification.kind !== "logging") return undefined;
        const data = notification.params.data as { lease_id?: string; reason?: string } | undefined;
        return data?.lease_id === leased.lease_id ? data.reason : undefined;
      });

      await env.restartDaemon();
      expect(await lostNotice).toBe("daemon-connection-lost");

      const statusAfterRestart = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusAfterRestart.isError).toBeFalsy();
      expect(statusAfterRestart.structuredContent).toEqual({ held: false });

      const devices = await mcp.client.callTool({ name: "list_devices", arguments: {} });
      expect(devices.isError, "expected a clean reconnect, not an INTERNAL error").toBeFalsy();
      expect(devices.structuredContent).toMatchObject({ platforms: expect.any(Array) });
    } finally {
      await mcp.close();
    }
  });
});
