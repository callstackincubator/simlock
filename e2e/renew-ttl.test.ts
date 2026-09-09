import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

interface LeaseRow {
  readonly id: string;
  readonly requesterId: string;
  readonly ttlMs: number;
  readonly ttlDeadline: number;
  readonly lastRenewedAt: number;
}

async function leaseRows(env: Awaited<ReturnType<typeof withDaemon>>): Promise<LeaseRow[]> {
  const result = await env.cli(["list", "--leases"]);
  if (result.code !== 0) throw new Error(`simlock list --leases failed: ${result.stderr}`);
  return result.json as LeaseRow[];
}

describe("TTL leases and client-side renewal (ADR 0004)", () => {
  it("refuses to start when lease.defaultTtlMs exceeds lease.maxTtlMs, naming the key", async () => {
    const env = await withDaemon({
      mode: "auto",
      configOverrides: { lease: { defaultTtlMs: 60_000, maxTtlMs: 30_000 } },
    });

    // Every command auto-starts on demand; the daemon process fails the config load before
    // it ever opens its socket, so the CLI retries for its startup window and then gives up
    // -- surfaced as an INTERNAL timeout, not a specific config error code (the CLI never
    // got a response to relay).
    const result = await env.cli(["catalog", "--json"], { timeout: 15_000 });
    expect(result.code).toBe(1);
    expect(result.error?.code).toBe("INTERNAL");

    await waitFor(
      async () => {
        try {
          const log = await readFile(env.logPath, "utf8");
          return log.includes("lease.defaultTtlMs");
        } catch {
          return false;
        }
      },
      { timeout: 10_000, label: "daemon.log names the offending config key" },
    );
  });

  it("keeps a renewing holder's lease alive (MCP and CLI) while an unrenewed lease expires", async () => {
    const env = await withDaemon({
      // Short enough that the unrenewed lease's expiry lands inside the test's own timeline;
      // both holders renew at a third of it, so they slide well past it (ADR 0004 §2).
      configOverrides: { lease: { defaultTtlMs: 4_000 } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "flow6-mcp" } });
    const cliHolder = env.cliBackground([
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

      const cliGrant = JSON.parse(await cliHolder.firstStdoutLine()) as {
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

      // Both holders -- MCP and CLI -- renew on their own timer at a third of the TTL (ADR
      // 0004 §2), pushing their deadline well past the grant-time one. The `--detach` lease
      // has no holder process at all, so nothing renews it and it expires exactly at its own
      // deadline.
      await waitFor(
        async () => {
          const rows = await leaseRows(env);
          return rows.every((row) => row.id !== detachedGrant.lease.id);
        },
        { timeout: 15_000, label: "the unrenewed --detach lease expires at its TTL" },
      );

      const rowsAfterExpiry = await leaseRows(env);
      const mcpRow = rowsAfterExpiry.find((row) => row.id === mcpLease.lease.id);
      const cliRow = rowsAfterExpiry.find((row) => row.id === cliGrant.lease.id);
      expect(mcpRow, "the MCP lease should have outlived the unrenewed one").toBeDefined();
      expect(cliRow, "the CLI holder's lease should have outlived the unrenewed one").toBeDefined();
      expect(mcpRow?.ttlDeadline).toBeGreaterThan(mcpLease.lease.ttlDeadline);
      expect(cliRow?.ttlDeadline).toBeGreaterThan(cliGrant.lease.ttlDeadline);
      // A body-less renew re-applies the lease's own width, so neither deadline drifted off
      // some other default, and `lastRenewedAt` moved with it.
      expect(mcpRow?.ttlMs).toBe(4_000);
      expect(cliRow?.ttlMs).toBe(4_000);
      expect(cliRow?.lastRenewedAt).toBeGreaterThan(cliGrant.lease.ttlDeadline - 4_000);

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
        "expected repeated lease.renewed events for the MCP session's own timer",
      ).toBeGreaterThan(1);
      expect(
        recorded.filter(
          (entry) =>
            entry.event === "lease.renewed" &&
            (entry.payload as { leaseId?: string }).leaseId === cliGrant.lease.id,
        ).length,
        "expected repeated lease.renewed events for the CLI holder's own timer",
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
      cliHolder.kill("SIGKILL");
      await cliHolder.waitForExit(15_000).catch(() => undefined);
      await mcp.close();
    }
  });

  it("renews a --detach lease by hand, keeping its own width, and caps what may be asked for", async () => {
    const env = await withDaemon({
      configOverrides: { lease: { defaultTtlMs: 60_000, maxTtlMs: 120_000 } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    // `--ttl` replaces `lease.defaultTtlMs` for this lease, and the width is stored on it.
    const granted = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "renew-by-hand",
      "--detach",
      "--ttl",
      "90s",
    ]);
    expect(granted.code).toBe(0);
    const grant = granted.json as { lease: { id: string; ttlMs: number; ttlDeadline: number } };
    expect(grant.lease.ttlMs).toBe(90_000);

    // A renew with no `--ttl` re-applies that 90s width rather than the 60s default.
    const renewed = await env.cli(["lease", "renew", grant.lease.id]);
    expect(renewed.code).toBe(0);
    const renewedLease = renewed.json as { ttlMs: number; ttlDeadline: number };
    expect(renewedLease.ttlMs).toBe(90_000);
    expect(renewedLease.ttlDeadline).toBeGreaterThanOrEqual(grant.lease.ttlDeadline);

    // Above `lease.maxTtlMs` is a BAD_REQUEST, not a silent clamp -- on a renew...
    const tooLong = await env.cli(["lease", "renew", grant.lease.id, "--ttl", "5m"]);
    expect(tooLong.code).toBe(2);
    expect(tooLong.error?.code).toBe("BAD_REQUEST");

    // ...and on a request.
    const tooLongRequest = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "asks-too-much",
      "--detach",
      "--ttl",
      "5m",
    ]);
    expect(tooLongRequest.code).toBe(2);
    expect(tooLongRequest.error?.code).toBe("BAD_REQUEST");

    await env.cli(["release", grant.lease.id]);
  });
});
