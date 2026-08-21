import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

interface LeaseRow {
  readonly id: string;
  readonly requesterId: string;
  readonly ttlDeadline: number;
  readonly lastHeartbeatAt?: number;
}

async function leaseRows(env: Awaited<ReturnType<typeof withDaemon>>): Promise<LeaseRow[]> {
  const result = await env.cli(["list", "--leases"]);
  if (result.code !== 0) throw new Error(`pitlane list --leases failed: ${result.stderr}`);
  return result.json as LeaseRow[];
}

describe("sliding TTL and heartbeat", () => {
  it("refuses to start with a heartbeat interval that isn't at most backstop / 4, naming the key", async () => {
    const env = await withDaemon({
      mode: "auto",
      configOverrides: { lease: { heldTtlBackstopMs: 4_000, heartbeatIntervalMs: 2_000 } },
    });

    // Every command auto-starts on demand; the daemon process crashes on the bad
    // config before it ever opens its socket, so the CLI retries for its startup
    // window and then gives up -- surfaced as an INTERNAL timeout, not a specific
    // config error code (the CLI never got a response to relay).
    const result = await env.cli(["catalog", "--json"], { timeout: 15_000 });
    expect(result.code).toBe(1);
    expect(result.error?.code).toBe("INTERNAL");

    await waitFor(
      async () => {
        try {
          const log = await readFile(env.logPath, "utf8");
          return log.includes("lease.heartbeatIntervalMs");
        } catch {
          return false;
        }
      },
      { timeout: 10_000, label: "daemon.log names the offending config key" },
    );
  });

  it("slides every heartbeat-capable held lease (MCP and CLI) past the backstop while a detached lease expires at it", async () => {
    const env = await withDaemon({
      // detachedTtlMs is pinned to the same value as heldTtlBackstopMs purely so the
      // detached lease's own (unrelated) TTL knob expires it on the timeline this
      // test already waits on -- detached mode never heartbeats regardless of TTL,
      // it just isn't naturally this short by default.
      configOverrides: {
        lease: { detachedTtlMs: 4_000, heldTtlBackstopMs: 4_000, heartbeatIntervalMs: 800 },
      },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const mcp = await env.mcpClient({ env: { PITLANE_AGENT_ID: "flow6-mcp" } });
    const cliHeld = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow6-cli",
    ]);

    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { platform: "ios", device: "iPhone 16", os: "18.4" },
      });
      const mcpLease = leaseResult.structuredContent as { lease_id: string; expires_at_ms: number };

      const cliGrant = JSON.parse(await cliHeld.firstStdoutLine()) as {
        lease: string;
        expires_at_ms: number;
      };

      const detachedResult = await env.cli([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--agent-id",
        "flow6-detached",
        "--detach",
      ]);
      const detachedGrant = detachedResult.json as { lease: string };

      // Both held leases -- MCP and CLI -- declare the heartbeat capability and
      // slide their deadline on every ping; the detached lease holds no connection
      // at all, never heartbeats, and expires exactly at its grant-time TTL.
      await waitFor(
        async () => {
          const rows = await leaseRows(env);
          const detachedRow = rows.find((row) => row.id === detachedGrant.lease);
          return detachedRow === undefined;
        },
        { timeout: 15_000, label: "detached (non-heartbeating) lease expires at its TTL" },
      );

      const rowsAfterExpiry = await leaseRows(env);
      const mcpRow = rowsAfterExpiry.find((row) => row.id === mcpLease.lease_id);
      const cliRow = rowsAfterExpiry.find((row) => row.id === cliGrant.lease);
      expect(
        mcpRow,
        "MCP lease should have survived past the detached lease's expiry",
      ).toBeDefined();
      expect(
        cliRow,
        "CLI held lease should have survived past the detached lease's expiry",
      ).toBeDefined();
      expect(mcpRow?.ttlDeadline).toBeGreaterThan(mcpLease.expires_at_ms);
      expect(mcpRow?.lastHeartbeatAt).toBeGreaterThan(0);
      expect(cliRow?.ttlDeadline).toBeGreaterThan(cliGrant.expires_at_ms);
      expect(cliRow?.lastHeartbeatAt).toBeGreaterThan(0);

      const statusResult = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      const statusExpiry = (statusResult.structuredContent as { expires_at_ms: number })
        .expires_at_ms;
      expect(statusExpiry).toBeGreaterThan(mcpLease.expires_at_ms);

      const recorded = await env.events();
      expect(
        recorded.filter(
          (entry) =>
            entry.event === "lease.renewed" &&
            (entry.payload as { leaseId?: string }).leaseId === mcpLease.lease_id,
        ).length,
        "expected repeated lease.renewed events for the heartbeating MCP lease",
      ).toBeGreaterThan(1);
      expect(
        recorded.filter(
          (entry) =>
            entry.event === "lease.renewed" &&
            (entry.payload as { leaseId?: string }).leaseId === cliGrant.lease,
        ).length,
        "expected repeated lease.renewed events for the heartbeating CLI lease",
      ).toBeGreaterThan(1);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          event: "lease.expired",
          payload: expect.objectContaining({ leaseId: detachedGrant.lease }),
        }),
      );

      await mcp.client.callTool({
        name: "release_simulator",
        arguments: { lease_id: mcpLease.lease_id },
      });
    } finally {
      cliHeld.kill("SIGKILL");
      await cliHeld.waitForExit(15_000).catch(() => undefined);
      await mcp.close();
    }
  });
});
