import { describe, expect, it } from "vitest";

import { events, waitFor, waitForDeviceState, withDaemon } from "./helpers/index.js";

function deviceOf(entry: { readonly payload: unknown }): unknown {
  return (entry.payload as { readonly deviceId?: unknown }).deviceId;
}

describe("lease lifecycle across both frontends", () => {
  it("catalog -> lease --detach -> status/list agree -> release -> device deleted -> events", async () => {
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

    await waitForDeviceState(env, leaseGrant.device.driverDeviceId, "deleted");

    await env.expectEvents([
      "lease.requested",
      "lease.granted",
      "lease.released",
      "device.deleted",
    ]);
  });

  it.each([
    ["ios", "iPhone 16", "18.4", true],
    ["ios", "iPhone 16", "18.4", false],
    ["android", "Pixel 8", "34", true],
    ["android", "Pixel 8", "34", false],
  ] as const)(
    "releasing a %s lease (%s, OS %s) with warmPool.enabled %s deletes its device with device.deleted initiator lease-end, and records no device.reclaimed",
    async (platform, model, osVersion, poolEnabled) => {
      const env = await withDaemon({
        configOverrides: { warmPool: { enabled: poolEnabled } },
        driverScript: { [platform]: { availableOsVersions: [osVersion], knownModels: [model] } },
      });

      const lease = await env.cli([
        "lease",
        "--platform",
        platform,
        "--device",
        model,
        "--os",
        osVersion,
        "--detach",
      ]);
      expect(lease.code, lease.stderr).toBe(0);
      const grant = lease.json as {
        lease: { id: string };
        device: { id: string; driverDeviceId: string };
      };

      const release = await env.cli(["release", grant.lease.id]);
      expect(release.code, release.stderr).toBe(0);

      await waitForDeviceState(env, grant.device.driverDeviceId, "deleted");
      await env.expectEvents(["lease.released", "device.deleted"]);
      const recorded = await events(env.env);
      expect(recorded.map((entry) => entry.event)).not.toContain("device.reclaimed");
      expect(
        recorded.find(
          (entry) => entry.event === "device.deleted" && deviceOf(entry) === grant.device.id,
        )?.payload,
      ).toMatchObject({ initiator: "lease-end" });
    },
  );

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
      defaultModels: {
        phone: ["iPhone 17", "iPhone 16", "iPhone 15"],
        watch: ["Apple Watch Series 11"],
      },
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

    /** The grant a `simlock lease` printed, after proving it exited 0. */
    function granted(result: { code: number | null; stderr: string; json: unknown }): Granted {
      expect(result.code, result.stderr).toBe(0);
      return result.json as Granted;
    }

    async function readyDeviceOf(env: Awaited<ReturnType<typeof withDaemon>>, model: string) {
      let found: { id: string; driverDeviceId: string } | undefined;
      await waitFor(
        async () => {
          const listed = await env.cli(["list", "--devices"]);
          found = (
            listed.json as {
              id: string;
              driverDeviceId: string;
              state: string;
              spec: { model: string };
            }[]
          ).find((device) => device.state === "ready" && device.spec.model === model);
          return found !== undefined;
        },
        { label: `a ready ${model}`, timeout: 30_000 },
      );
      if (found === undefined) throw new Error(`no ready ${model}`);
      return found;
    }

    async function withWarmTarget(
      target: { model: string; osVersion: string; mode?: "slim" | "full" },
      options: { configOverrides?: Record<string, unknown>; script?: Record<string, unknown> } = {},
    ) {
      const env = await withDaemon({
        configOverrides: {
          ...options.configOverrides,
          warmPool: { targets: [{ count: 1, platform: "ios", ...target }] },
        },
        driverScript: { ios: { ...iosScript, ...options.script } },
      });
      return { env, warmed: await readyDeviceOf(env, target.model) };
    }

    it("grants a lease with no --device and no --class a phone, the grant naming its model and OS", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });

      const result = await lease(env, "agent", []);

      expect(result.code, result.stderr).toBe(0);
      expect(granted(result).device.spec).toMatchObject({
        model: "iPhone 17",
        osVersion: "26.0",
      });
    });

    it("grants --class phone a ready idle iPhone 15 without provisioning or booting, and not to an exact iPhone 16 request", async () => {
      const { env, warmed } = await withWarmTarget({ model: "iPhone 15", osVersion: "26.0" });

      const exact = await lease(env, "exact", ["--device", "iPhone 16"]);
      expect(exact.code, exact.stderr).toBe(0);
      expect(granted(exact).device.id).not.toBe(warmed.id);
      expect(granted(exact).device.spec.model).toBe("iPhone 16");

      const byClass = await lease(env, "by-class", ["--class", "phone"]);
      expect(byClass.code, byClass.stderr).toBe(0);
      expect(granted(byClass).device.id).toBe(warmed.id);
      // why: the pool refills its target after the grant, so the grant itself is read from its event.
      const grant = (await events(env.env)).find(
        (entry) =>
          entry.event === "lease.granted" &&
          (entry.payload as { leaseId?: string }).leaseId === granted(byClass).lease.id,
      );
      expect(grant?.payload).toMatchObject({ source: "warm" });
    });

    it("does not grant a request with no class an idle Apple Watch, and grants --class watch it", async () => {
      const { env, warmed } = await withWarmTarget({
        model: "Apple Watch Series 11",
        osVersion: "18.4",
      });

      const noClass = await lease(env, "no-class", []);
      expect(granted(noClass).device.id).not.toBe(warmed.id);

      const byClass = await lease(env, "by-class", ["--class", "watch"]);
      expect(granted(byClass).device.id).toBe(warmed.id);
    });

    it("never grants a --mode full request a slim device, and a worker defaulting to full never grants one to a request with no mode", async () => {
      const { env, warmed } = await withWarmTarget(
        { mode: "slim", model: "iPhone 15", osVersion: "26.0" },
        {
          configOverrides: { ios: { defaultMode: "full" } },
          script: { slimmableOsVersions: ["26.0"] },
        },
      );

      const full = await lease(env, "full", ["--class", "phone", "--mode", "full"]);
      expect(granted(full).device.id).not.toBe(warmed.id);

      const noMode = await lease(env, "no-mode", ["--class", "phone"]);
      expect(granted(noMode).device.id).not.toBe(warmed.id);
    });

    it("never grants an --image-tag request a device of another tag", async () => {
      const env = await withDaemon({
        driverScript: {
          android: {
            availableOsVersions: ["34"],
            defaultModels: { phone: ["Pixel 8"] },
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
      const firstDevice = granted(first).device;
      await env.cli(["release", granted(first).lease.id]);
      // why: the release deleted that device (its record stays, state deleted); the warm pool makes a ready one of the same kind.
      await waitForDeviceState(env, firstDevice.driverDeviceId, "deleted");
      const idle = await readyDeviceOf(env, "Pixel 8");

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
      expect(granted(second).device.id).not.toBe(idle.id);
    });

    it("refuses --class beside --device with BAD_REQUEST", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });

      const result = await lease(env, "agent", ["--class", "phone", "--device", "iPhone 16"]);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("BAD_REQUEST");
    });

    it("grants --os '>=18' a device on 18.0 or newer, fails --os '<=17' at once with RUNTIME_MISSING with and without --allow-download, and refuses --os '^18' with BAD_REQUEST naming the accepted forms", async () => {
      const env = await withDaemon({ driverScript: { ios: iosScript } });

      const inRange = await lease(env, "in-range", ["--os", ">=18"]);
      expect(inRange.code, inRange.stderr).toBe(0);
      expect(Number.parseFloat(granted(inRange).device.spec.osVersion)).toBeGreaterThanOrEqual(18);
      await env.cli(["release", granted(inRange).lease.id]);

      await env.driverLog.clear();
      for (const extra of [[], ["--allow-download"]]) {
        const missing = await lease(env, "missing", ["--os", "<=17", ...extra]);
        expect(missing.code).toBe(12);
        expect(missing.stderr).toContain("RUNTIME_MISSING");
      }
      expect(
        (await env.driverLog.calls()).filter((call) => call.operation === "installComponent"),
      ).toEqual([]);

      const malformed = await lease(env, "malformed", ["--os", "^18"]);
      expect(malformed.code).not.toBe(0);
      expect(malformed.stderr).toContain("BAD_REQUEST");
      expect(malformed.stderr).toContain("18 - 26");
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
        expect(granted(result).device.spec).toMatchObject({
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
