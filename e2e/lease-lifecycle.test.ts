import { describe, expect, it } from "vitest";

import { waitForDeviceState, withDaemon } from "./helpers/index.js";

describe("lease lifecycle across both frontends", () => {
  it("catalog -> lease --detach -> status/list agree -> release -> device returns to ready -> events", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const agentId = "flow2-cli-agent";

    const catalogJson = await env.cli(["catalog", "--json"]);
    expect(catalogJson.code).toBe(0);
    expect(catalogJson.json).toMatchObject({
      platforms: expect.arrayContaining([
        expect.objectContaining({ platform: "ios", models: ["iPhone 16"], defaultRuntime: "18.4" }),
      ]),
    });

    const catalogHuman = await env.cli(["catalog"]);
    expect(catalogHuman.code).toBe(0);
    expect(catalogHuman.stdout).toContain("iPhone 16");

    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      agentId,
      "--detach",
    ]);
    expect(lease.code).toBe(0);
    const leaseGrant = lease.json as {
      lease: { id: string };
      device: { spec: { model: string }; driverDeviceId: string };
    };
    expect(leaseGrant.device.spec.model).toBe("iPhone 16");

    const statusJson = await env.cli(["status", "--json"]);
    expect(statusJson.code).toBe(0);
    expect(statusJson.json).toMatchObject({
      leases: expect.arrayContaining([
        expect.objectContaining({ id: leaseGrant.lease.id, requesterId: agentId }),
      ]),
    });

    const listLeases = await env.cli(["list", "--leases"]);
    expect(listLeases.code).toBe(0);
    expect(listLeases.json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: leaseGrant.lease.id, requesterId: agentId }),
      ]),
    );

    const release = await env.cli(["release", leaseGrant.lease.id]);
    expect(release.code).toBe(0);

    await waitForDeviceState(env, leaseGrant.device.driverDeviceId, "ready");

    await env.expectEvents(["lease.requested", "lease.granted", "lease.released"]);
  });

  it("agrees with the CLI when the lease/release cycle runs through MCP", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const agentId = "flow2-mcp-agent";

    const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: agentId } });
    try {
      const leaseResult = await mcp.client.callTool({
        name: "lease_simulator",
        arguments: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      });
      const leased = leaseResult.structuredContent as {
        device: { driverDeviceId: string; spec: { model: string } };
        lease: { id: string };
      };
      expect(leased.device.spec.model).toBe("iPhone 16");

      const statusResult = await mcp.client.callTool({ name: "lease_status", arguments: {} });
      expect(statusResult.structuredContent).toMatchObject({
        held: true,
        id: leased.lease.id,
      });

      // The CLI frontend must see the exact same lease, keyed by the same requester id.
      const cliLeases = await env.cli(["list", "--leases"]);
      expect(cliLeases.code).toBe(0);
      expect(cliLeases.json).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: leased.lease.id, requesterId: agentId }),
        ]),
      );

      // A slow purge is the realistic case (an iOS erase runs tens of seconds), and
      // the agent must not be made to sit through it: release_simulator returns on
      // the registry commit and the wipe finishes behind it.
      await env.driverScript.merge({ ios: { latencyMs: { reclaim: 5_000 } } });

      const releaseResult = await mcp.client.callTool({
        name: "release_simulator",
        arguments: { leaseId: leased.lease.id },
      });
      expect(releaseResult.structuredContent).toMatchObject({
        leaseId: leased.lease.id,
        released: true,
      });

      // Already answered, while the erase it handed off is still running: the lease is
      // gone from the CLI's view and the device is `reclaiming`, not yet `ready`.
      const cliLeasesAfter = await env.cli(["list", "--leases"]);
      expect(cliLeasesAfter.json).toEqual([]);
      const midPurge = await env.cli(["list", "--devices"]);
      expect(midPurge.json).toEqual([
        expect.objectContaining({
          driverDeviceId: leased.device.driverDeviceId,
          state: "reclaiming",
        }),
      ]);

      await waitForDeviceState(env, leased.device.driverDeviceId, "ready");
    } finally {
      await mcp.close();
    }
  });
});
