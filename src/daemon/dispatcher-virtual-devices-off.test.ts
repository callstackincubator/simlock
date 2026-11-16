import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

type Off = "android" | "ios";

const OTHER: Record<Off, Off> = { android: "ios", ios: "android" };

function refusal(platform: Off): string {
  return (
    `This worker serves only enrolled physical ${platform} devices ` +
    `(${platform}.virtualDevices is false); ask for a physical device (--physical, or physical: true)`
  );
}

// why: the request shapes of ADR 0078's Examples, each a plain lease on the phones-only platform.
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
    },
  );
});
