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
});
