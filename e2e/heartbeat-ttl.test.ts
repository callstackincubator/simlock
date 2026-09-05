import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

interface LeaseRow {
  readonly id: string;
  readonly requesterId: string;
  readonly ttlDeadline: number;
}

async function leaseRows(env: Awaited<ReturnType<typeof withDaemon>>): Promise<LeaseRow[]> {
  const result = await env.cli(["list", "--leases"]);
  if (result.code !== 0) throw new Error(`simlock list --leases failed: ${result.stderr}`);
  return result.json as LeaseRow[];
}

describe("sliding TTL and renewal", () => {
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

  it("slides every held lease (MCP and CLI) past the backstop while a detached lease expires at it", async () => {
    const env = await withDaemon({
      // detachedTtlMs is pinned to the same value as heldTtlBackstopMs purely so the
      // detached lease's own (unrelated) TTL knob expires it on the timeline this
      // test already waits on -- a detached lease has no holder renewing it regardless
      // of TTL, it just isn't naturally this short by default.
      //
      // heartbeatIntervalMs is no longer what keeps the held leases alive (their holders
      // renew on their own timer, ADR 0004 §2); it stays here because the config validator
      // still requires it to be at most heldTtlBackstopMs / 4, and 4_000ms is short.
      configOverrides: {
        lease: { detachedTtlMs: 4_000, heldTtlBackstopMs: 4_000, heartbeatIntervalMs: 800 },
      },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow6-mcp" } });
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
        arguments: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      });
      const mcpLease = leaseResult.structuredContent as {
        lease: { id: string; ttlDeadline: number };
      };

      const cliGrant = JSON.parse(await cliHeld.firstStdoutLine()) as {
        lease: { id: string; ttlDeadline: number };
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
      const detachedGrant = detachedResult.json as { lease: { id: string } };

      // Both held holders -- MCP and CLI -- renew on their own timer at a third of the
      // TTL (ADR 0004 §2), sliding their deadline well past the backstop; the detached
      // lease has no holder process at all, renews never, and expires exactly at its
      // grant-time TTL.
      await waitFor(
        async () => {
          const rows = await leaseRows(env);
          const detachedRow = rows.find((row) => row.id === detachedGrant.lease.id);
          return detachedRow === undefined;
        },
        { timeout: 15_000, label: "detached (unrenewed) lease expires at its TTL" },
      );

      const rowsAfterExpiry = await leaseRows(env);
      const mcpRow = rowsAfterExpiry.find((row) => row.id === mcpLease.lease.id);
      const cliRow = rowsAfterExpiry.find((row) => row.id === cliGrant.lease.id);
      expect(
        mcpRow,
        "MCP lease should have survived past the detached lease's expiry",
      ).toBeDefined();
      expect(
        cliRow,
        "CLI held lease should have survived past the detached lease's expiry",
      ).toBeDefined();
      expect(mcpRow?.ttlDeadline).toBeGreaterThan(mcpLease.lease.ttlDeadline);
      expect(cliRow?.ttlDeadline).toBeGreaterThan(cliGrant.lease.ttlDeadline);

      const statusResult = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      const statusExpiry = (statusResult.structuredContent as { ttlDeadline: number }).ttlDeadline;
      expect(statusExpiry).toBeGreaterThan(mcpLease.lease.ttlDeadline);

      const recorded = await env.events();
      expect(
        recorded.filter(
          (entry) =>
            entry.event === "lease.renewed" &&
            (entry.payload as { leaseId?: string }).leaseId === mcpLease.lease.id,
        ).length,
        "expected repeated lease.renewed events for the renewing MCP lease",
      ).toBeGreaterThan(1);
      expect(
        recorded.filter(
          (entry) =>
            entry.event === "lease.renewed" &&
            (entry.payload as { leaseId?: string }).leaseId === cliGrant.lease.id,
        ).length,
        "expected repeated lease.renewed events for the renewing CLI lease",
      ).toBeGreaterThan(1);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          event: "lease.expired",
          payload: expect.objectContaining({ leaseId: detachedGrant.lease.id }),
        }),
      );

      await mcp.client.callTool({
        name: "release_simulator",
        arguments: { leaseId: mcpLease.lease.id },
      });
    } finally {
      cliHeld.kill("SIGKILL");
      await cliHeld.waitForExit(15_000).catch(() => undefined);
      await mcp.close();
    }
  });
});
