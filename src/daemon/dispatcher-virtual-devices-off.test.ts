import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, flushPromises, session } from "./test-dispatcher.js";

type Off = "android" | "ios";

const OTHER: Record<Off, Off> = { android: "ios", ios: "android" };

function refusal(platform: Off): string {
  return (
    `This worker serves only enrolled physical ${platform} devices ` +
    `(${platform}.virtualDevices is false); ask for a physical device (--physical, or physical: true)`
  );
}

// why: the request shapes of ADR 0084's Examples, each a plain lease on the phones-only platform.
function plainRequests(platform: Off): readonly Record<string, unknown>[] {
  return [
    { platform },
    { model: "Pixel 9", platform },
    { osVersion: ">=34", platform },
    { allowDownload: true, osVersion: "36", platform },
    { baseline: "checkout", platform },
    { noWait: true, platform },
    ...(platform === "android" ? [{ imageTag: "google_apis_playstore", platform }] : []),
    ...(platform === "ios" ? [{ except: ["audio"], mode: "slim", platform }] : []),
  ];
}

describe("a worker whose <platform>.virtualDevices is false", () => {
  it.each(["android", "ios"] as const)(
    "refuses a plain %s lease at once with UNKNOWN_MODEL naming the key, never touching the driver, and serves the other platform",
    async (off) => {
      const clock = new FakeClock(1_000);
      const offDriver = new FakeDriver({ availableOsVersions: ["36"], clock, platform: off });
      const otherDriver = new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        knownModels: ["Other"],
        platform: OTHER[off],
      });
      const { dispatcher, eventBus } = await buildDispatcher({
        clock,
        driverOptions: { platform: "ios" },
        extraDrivers: [offDriver, otherDriver],
        virtualDevices: { [off]: false },
      });
      const requests = plainRequests(off);

      for (const [index, request] of requests.entries()) {
        const error = await dispatcher
          .dispatch("lease.request", { ...request, requesterId: `agent-${index}` }, session())
          .then(
            () => undefined,
            (rejection: unknown) => rejection,
          );
        expect(classifyError(error), JSON.stringify(request)).toBe("UNKNOWN_MODEL");
        expect(error).toMatchObject({ message: refusal(off), platform: off });
      }

      expect(eventBus.replay().filter((event) => event.event === "lease.requested")).toHaveLength(
        requests.length,
      );
      const operations = offDriver.calls.map((call) => call.operation);
      expect(operations).not.toContain("resolveSpec");
      expect(operations).not.toContain("listCatalog");
      expect(operations).not.toContain("installComponent");

      const served = await dispatcher.dispatch(
        "lease.request",
        { model: "Other", platform: OTHER[off], requesterId: "agent-other" },
        session(),
      );
      expect(served.device.spec.platform).toBe(OTHER[off]);
    },
  );

  it("serves a --physical lease as on any worker: granted, waiting, NO_CAPACITY with noWait, UNKNOWN_MODEL with no enrolled match", async () => {
    const { dispatcher, driver, engine } = await buildDispatcher({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: { class: "phone", model: "iPhone 15", osVersion: "18.4" },
          state: "ready",
        },
      ],
      virtualDevices: { ios: false },
    });
    await engine.convergeRunningCapacity();
    driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);
    const phone = { model: "iPhone 15", physical: true, platform: "ios" } as const;
    const ask = (input: Record<string, unknown>, requesterId: string) =>
      dispatcher.dispatch("lease.request", { ...input, requesterId }, session());

    const granted = await ask(phone, "first");
    expect(granted.device).toMatchObject({ id: "dev_phys", physical: true });

    const noWait = await ask({ ...phone, noWait: true }, "second").then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(classifyError(noWait)).toBe("NO_CAPACITY");

    let waiterSettled = false;
    const waiter = ask(phone, "third").finally(() => {
      waiterSettled = true;
    });
    await flushPromises();
    expect(waiterSettled).toBe(false);
    await dispatcher.dispatch("lease.release", { leaseId: granted.lease.id }, session());
    await expect(waiter).resolves.toMatchObject({ device: { id: "dev_phys", physical: true } });

    const unmatched = await ask({ ...phone, model: "iPhone 99" }, "fourth").then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(classifyError(unmatched)).toBe("UNKNOWN_MODEL");
    expect((unmatched as Error).message).toContain("no enrolled physical device can match");
  });

  it("catalog.get answers a phones-only platform with empty lists and virtualDevices false, without asking its driver, and the other platform in full", async () => {
    const clock = new FakeClock(1_000);
    const android = new FakeDriver({
      availableOsVersions: ["36"],
      clock,
      knownModels: ["Pixel 8"],
      platform: "android",
    });
    const { dispatcher } = await buildDispatcher({
      clock,
      extraDrivers: [android],
      virtualDevices: { android: false },
    });
    const phonesOnly = {
      classDefaults: {},
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: {},
      models: [],
      platform: "android",
      runtimes: [],
      virtualDevices: false,
    };

    const only = await dispatcher.dispatch("catalog.get", { platform: "android" }, session());
    const both = await dispatcher.dispatch("catalog.get", {}, session());

    expect(only.platforms).toEqual([phonesOnly]);
    expect(both.platforms).toHaveLength(2);
    expect(both.platforms.find((entry) => entry.platform === "android")).toEqual(phonesOnly);
    expect(both.platforms.find((entry) => entry.platform === "ios")).toMatchObject({
      runtimes: ["26.5"],
    });
    expect(both.platforms.find((entry) => entry.platform === "ios")).not.toHaveProperty(
      "virtualDevices",
    );
    expect(android.calls.map((call) => call.operation)).not.toContain("listCatalog");
  });

  it("installs, lists and removes components on a phones-only platform as on any worker", async () => {
    const { dispatcher } = await buildDispatcher({ virtualDevices: { ios: false } });
    const admin = session({ principal: "tok_operator", role: "admin" });
    const component = { platform: "ios", version: "27.0" } as const;

    await expect(dispatcher.dispatch("component.install", component, admin)).resolves.toEqual({
      component: "27.0",
      outcome: "installed",
      platform: "ios",
      version: "27.0",
    });
    const listed = await dispatcher.dispatch("component.list", { platform: "ios" }, admin);
    expect(listed.components.map((entry) => entry.version)).toContain("27.0");
    await expect(dispatcher.dispatch("component.remove", component, admin)).resolves.toMatchObject({
      outcome: "removed",
    });
    const after = await dispatcher.dispatch("component.list", { platform: "ios" }, admin);
    expect(after.components.map((entry) => entry.version)).not.toContain("27.0");
  });
});
