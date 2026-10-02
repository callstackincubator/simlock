import { describe, expect, it } from "vitest";

import { events, withDaemon } from "./helpers/index.js";

const MISSING = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "19.0"] as const;

describe("lease-triggered component installs", () => {
  it("installs a missing runtime once for two concurrent leases with --allow-download, and grants both", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["18.4"],
        knownModels: ["iPhone 16"],
        // Long enough that the second request arrives while the first install still runs.
        latencyMs: { installComponent: 1_000 },
      },
    });
    await env.driverLog.clear();

    const [first, second] = await Promise.all(
      ["agent-a", "agent-b"].map((agentId) =>
        env.cli([...MISSING, "--allow-download", "--agent-id", agentId, "--detach"], {
          timeout: 30_000,
        }),
      ),
    );

    expect(first?.code, first?.stderr).toBe(0);
    expect(second?.code, second?.stderr).toBe(0);
    const installs = (await env.driverLog.calls()).filter(
      (call) => call.operation === "installComponent",
    );
    expect(installs.map((call) => call.arguments)).toEqual([["19.0"]]);
    const componentEvents = (await events(env.env))
      .filter((entry) => entry.event.startsWith("component."))
      .map((entry) => entry.event);
    expect(componentEvents).toEqual(["component.install-started", "component.installed"]);
  });
});
