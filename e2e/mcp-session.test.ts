import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

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
        arguments: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
        _meta: { progressToken: "flow7-token" },
      });
      const leased = leaseResult.structuredContent as { lease: { id: string } };

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
        id: leased.lease.id,
      });

      const released = await mcp.client.callTool({
        name: "release_simulator",
        arguments: { leaseId: leased.lease.id },
      });
      expect(released.structuredContent).toEqual({
        leaseId: leased.lease.id,
        released: true,
      });
    } finally {
      await mcp.close();
    }
  });

  it("relays a force-release from the CLI as a logging warning, then FORBIDDEN is a clean tool error, and the server stays usable", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow7-force-release" } });

    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      });
      const leased = leaseResult.structuredContent as { lease: { id: string } };

      const forceRelease = await env.cli(["release", "--all", "--yes"]);
      expect(forceRelease.code).toBe(0);

      const warning = await mcp.waitForNotification((notification) => {
        if (notification.kind !== "logging") return undefined;
        const data = notification.params.data as
          | { deviceId?: string; leaseId?: string; reason?: string }
          | undefined;
        return data?.leaseId === leased.lease.id ? notification.params : undefined;
      });
      expect(warning.logger).toBe("simlock");
      expect(warning.level).toBe("warning");
      expect(warning.data).toMatchObject({
        deviceId: expect.any(String),
        leaseId: leased.lease.id,
        reason: "explicit",
      });

      const statusAfter = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusAfter.structuredContent).toEqual({ held: false });

      // The daemon's own ownership rule now answers, not a client-side pre-check (ADR
      // 0003 §11) -- but `ownsLease` (src/contract/roles.ts) treats an id its registry
      // lookup does not recognize as authorized on purpose, precisely so the handler's own
      // "unknown resource" error surfaces instead of a misleading FORBIDDEN. A force-release
      // fully removes the lease from the registry (`LeaseCommands#releaseAll`), so a stale
      // release for it is UNKNOWN_LEASE, not FORBIDDEN -- FORBIDDEN is reserved for a lease
      // that still exists but is owned by someone else.
      const staleRelease = await mcp.client.callTool({
        name: "release_simulator",
        arguments: { leaseId: leased.lease.id },
      });
      expect(staleRelease.isError).toBe(true);
      const errorPayload = JSON.parse(
        (staleRelease.content as { text: string }[])[0]?.text ?? "{}",
      ) as McpErrorPayload;
      expect(errorPayload.code).toBe("UNKNOWN_LEASE");

      // Still usable: a clean tool error must not have wedged the session/transport.
      const devices = await mcp.client.callTool({ name: "list_devices", arguments: {} });
      expect(devices.isError).toBeFalsy();
    } finally {
      await mcp.close();
    }
  });

  // Regression for PR #35 ("reconnect the session after a daemon restart"), now covering
  // ADR 0004's second reconnect trigger as well: before #35 an MCP server whose daemon
  // connection died mid-session surfaced the *next* tool call as an opaque INTERNAL error
  // instead of reconnecting; before ADR 0004 the restart also cost it the lease outright.
  it("keeps its lease across a daemon restart, renewing it over a connection of its own", async () => {
    // ADR 0004: a restart releases nothing, so the session's lease is still granted
    // afterwards -- and its renew timer reconnects to the daemon that is listening again and
    // renews it, without waiting for a tool call that may never come (§2's second reconnect
    // trigger). The short TTL is what makes the timer fire inside this test.
    const env = await withDaemon({ configOverrides: { lease: { defaultTtlMs: 6_000 } } });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow7-restart" } });

    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      });
      const leased = leaseResult.structuredContent as { lease: { id: string } };

      await env.restartDaemon();

      const leaseRow = async (): Promise<{ ttlDeadline: number } | undefined> => {
        const rows = (await env.cli(["list", "--leases"])).json as {
          id: string;
          ttlDeadline: number;
        }[];
        return rows.find((row) => row.id === leased.lease.id);
      };

      // Still granted the moment the new daemon is up: nothing swept it, and its timer was
      // restored from the persisted deadline.
      const afterRestart = await leaseRow();
      expect(afterRestart, "the lease should have survived the restart").toBeDefined();
      const deadlineAfterRestart = afterRestart?.ttlDeadline ?? 0;

      // No tool call in between: the only thing that can push this deadline out is the
      // session's own renew timer, over a connection it built for itself.
      await waitFor(async () => ((await leaseRow())?.ttlDeadline ?? 0) > deadlineAfterRestart, {
        timeout: 20_000,
        label: "the MCP session renews its lease after the restart",
      });

      // And the session still knows the lease is its own.
      const statusAfterRestart = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusAfterRestart.isError).toBeFalsy();
      expect(statusAfterRestart.structuredContent).toMatchObject({
        held: true,
        id: leased.lease.id,
      });

      const devices = await mcp.client.callTool({ name: "list_devices", arguments: {} });
      expect(devices.isError, "expected a clean reconnect, not an INTERNAL error").toBeFalsy();
      expect(devices.structuredContent).toMatchObject({ platforms: expect.any(Array) });

      await mcp.client.callTool({
        name: "release_simulator",
        arguments: { leaseId: leased.lease.id },
      });
    } finally {
      await mcp.close();
    }
  });
});
