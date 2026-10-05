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

  it("catalog shows each class's default model: the configured name before the driver's list, skipped when the catalog does not list it", async () => {
    const script = {
      ios: {
        availableOsVersions: ["26.0"],
        defaultModels: { phone: ["iPhone 17", "iPhone 16"], tablet: ["iPad Pro"] },
        knownModels: ["iPhone 15", "iPhone 16", "iPad Pro"],
        modelClasses: { "iPad Pro": "tablet", "iPhone 15": "phone", "iPhone 16": "phone" },
      },
    } as const;
    const defaultsWith = async (phone: string | undefined) => {
      const env = await withDaemon({
        configOverrides: phone === undefined ? {} : { ios: { defaultModels: { phone } } },
        driverScript: script,
      });
      const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
      expect(catalog.code, catalog.stderr).toBe(0);
      return (catalog.json as { platforms: { classDefaults: unknown }[] }).platforms[0]
        ?.classDefaults;
    };

    // The driver's list alone: iPhone 17 is not listed, so iPhone 16 is the first that counts.
    expect(await defaultsWith(undefined)).toEqual({ phone: "iPhone 16", tablet: "iPad Pro" });
    expect(await defaultsWith("iPhone 15")).toEqual({ phone: "iPhone 15", tablet: "iPad Pro" });
    expect(await defaultsWith("iPhone 99")).toEqual({ phone: "iPhone 16", tablet: "iPad Pro" });
  });
});
