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

  describe("a request names a class or nothing", () => {
    const iosScript = {
      availableOsVersions: ["18.4", "26.0"],
      defaultModels: { phone: ["iPhone 17", "iPhone 16", "iPhone 15"] },
      knownModels: ["Apple Watch Series 11", "iPhone 15", "iPhone 16", "iPhone 17"],
      modelClasses: {
        "Apple Watch Series 11": "watch",
        "iPhone 15": "phone",
        "iPhone 16": "phone",
        "iPhone 17": "phone",
      },
    } as const;

    interface Granted {
      lease: { id: string };
      device: {
        id: string;
        driverDeviceId: string;
        mode: string;
        spec: { model: string; osVersion: string };
      };
    }

    async function lease(
      env: Awaited<ReturnType<typeof withDaemon>>,
      agent: string,
      args: string[],
    ) {
      const result = await env.cli([
        "lease",
        "--platform",
        "ios",
        ...args,
        "--agent-id",
        agent,
        "--detach",
      ]);
      return result;
    }

    /** Leases and releases an exact device, leaving it warm and idle. */
    async function warm(env: Awaited<ReturnType<typeof withDaemon>>, model: string) {
      const result = await lease(env, "warmer", ["--device", model, "--os", "18.4"]);
      expect(result.code, result.stderr).toBe(0);
      const granted = result.json as Granted;
      await env.cli(["release", granted.lease.id]);
      await waitForDeviceState(env, granted.device.driverDeviceId, "ready");
      return granted.device;
    }

    async function deviceWork(env: Awaited<ReturnType<typeof withDaemon>>) {
      return (await env.driverLog.calls()).filter((call) =>
        ["provision", "makeReady"].includes(call.operation),
      ).length;
    }

    it("grants a lease with no --device and no --class a phone, the grant naming its model and OS", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });

      const result = await lease(env, "agent", []);

      expect(result.code, result.stderr).toBe(0);
      expect((result.json as Granted).device.spec).toMatchObject({
        model: "iPhone 17",
        osVersion: "26.0",
      });
    });

    it("grants --class phone a ready idle iPhone 15 without provisioning or booting, and not to an exact iPhone 16 request", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });
      const warmed = await warm(env, "iPhone 15");
      await env.driverLog.clear();

      const byClass = await lease(env, "by-class", ["--class", "phone"]);
      expect(byClass.code, byClass.stderr).toBe(0);
      expect((byClass.json as Granted).device.id).toBe(warmed.id);
      expect(await deviceWork(env)).toBe(0);

      const exact = await lease(env, "exact", ["--device", "iPhone 16"]);
      expect(exact.code, exact.stderr).toBe(0);
      expect((exact.json as Granted).device.id).not.toBe(warmed.id);
      expect((exact.json as Granted).device.spec.model).toBe("iPhone 16");
    });

    it("does not grant a request with no class an idle Apple Watch, and grants --class watch it", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });
      const watch = await lease(env, "warmer", [
        "--device",
        "Apple Watch Series 11",
        "--os",
        "18.4",
      ]);
      const watchDevice = (watch.json as Granted).device;
      await env.cli(["release", (watch.json as Granted).lease.id]);
      await waitForDeviceState(env, watchDevice.driverDeviceId, "ready");

      const noClass = await lease(env, "no-class", []);
      expect((noClass.json as Granted).device.id).not.toBe(watchDevice.id);
      await env.cli(["release", (noClass.json as Granted).lease.id]);

      const byClass = await lease(env, "by-class", ["--class", "watch"]);
      expect((byClass.json as Granted).device.id).toBe(watchDevice.id);
    });

    it("never grants a --mode full request a slim device, and a worker defaulting to full never grants one to a request with no mode", async () => {
      const env = await withDaemon({
        configOverrides: { ios: { defaultMode: "full" } },
        driverScript: { ios: { ...iosScript, slimmableOsVersions: ["26.0"] } },
      });
      const slim = await lease(env, "slim", [
        "--device",
        "iPhone 15",
        "--os",
        "26.0",
        "--mode",
        "slim",
      ]);
      const slimDevice = (slim.json as Granted).device;
      await env.cli(["release", (slim.json as Granted).lease.id]);
      await waitForDeviceState(env, slimDevice.driverDeviceId, "ready");

      const full = await lease(env, "full", ["--class", "phone", "--mode", "full"]);
      expect((full.json as Granted).device.id).not.toBe(slimDevice.id);
      await env.cli(["release", (full.json as Granted).lease.id]);

      const noMode = await lease(env, "no-mode", ["--class", "phone"]);
      expect((noMode.json as Granted).device.id).not.toBe(slimDevice.id);
    });

    it("never grants an --image-tag request a device of another tag", async () => {
      const env = await withDaemon({
        driverScript: {
          android: {
            availableOsVersions: ["34"],
            images: [
              { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
              { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
            ],
            knownModels: ["Pixel 8"],
            modelClasses: { "Pixel 8": "phone" },
          },
        },
      });
      const first = await env.cli([
        "lease",
        "--platform",
        "android",
        "--class",
        "phone",
        "--image-tag",
        "google_apis",
        "--agent-id",
        "one",
        "--detach",
      ]);
      const firstDevice = (first.json as Granted).device;
      await env.cli(["release", (first.json as Granted).lease.id]);
      await waitForDeviceState(env, firstDevice.driverDeviceId, "ready");

      const second = await env.cli([
        "lease",
        "--platform",
        "android",
        "--class",
        "phone",
        "--image-tag",
        "google_apis_playstore",
        "--agent-id",
        "two",
        "--detach",
      ]);

      expect(second.code, second.stderr).toBe(0);
      expect((second.json as Granted).device.id).not.toBe(firstDevice.id);
    });

    it("refuses --class beside --device with BAD_REQUEST", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });

      const result = await lease(env, "agent", ["--class", "phone", "--device", "iPhone 16"]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("BAD_REQUEST");
    });

    it.each([
      [undefined, "iPhone 17"],
      ["iPhone 15", "iPhone 15"],
      ["iPhone 99", "iPhone 17"],
    ])(
      "with ios.defaultModels.phone set to %s and nothing idle, --class phone creates %s on the newest runtime",
      async (configured, created) => {
        const env = await withDaemon({
          configOverrides:
            configured === undefined ? {} : { ios: { defaultModels: { phone: configured } } },
          driverScript: { ios: iosScript },
        });

        const result = await lease(env, "agent", ["--class", "phone"]);

        expect(result.code, result.stderr).toBe(0);
        expect((result.json as Granted).device.spec).toMatchObject({
          model: created,
          osVersion: "26.0",
        });
      },
    );

    it("fails an Android --class tablet at once with UNKNOWN_MODEL naming android.defaultModels.tablet", async () => {
      const env = await withDaemon({
        driverScript: {
          android: {
            availableOsVersions: ["34"],
            knownModels: ["Pixel 8"],
            modelClasses: { "Pixel 8": "phone" },
          },
        },
      });

      const result = await env.cli([
        "lease",
        "--platform",
        "android",
        "--class",
        "tablet",
        "--detach",
      ]);

      expect(result.code).toBe(12);
      expect(result.stderr).toContain("UNKNOWN_MODEL");
      expect(result.stderr).toContain("android.defaultModels.tablet");
    });
  });
});
