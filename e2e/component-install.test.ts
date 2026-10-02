import { describe, expect, it } from "vitest";

import { events, waitFor, withDaemon } from "./helpers/index.js";

const MISSING = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "19.0"] as const;

describe("lease-triggered component installs", () => {
  it("installs a missing runtime once for two concurrent leases with --allow-download, and grants both", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["18.4"],
        knownModels: ["iPhone 16"],
        // Long enough that the second request surely arrives while the first install runs.
        latencyMs: { installComponent: 3_000 },
      },
    });
    await env.driverLog.clear();

    const first = env.cliBackground([
      ...MISSING,
      "--allow-download",
      "--agent-id",
      "agent-a",
      "--detach",
    ]);
    await waitFor(
      async () =>
        (await env.driverLog.calls()).some((call) => call.operation === "installComponent"),
      { label: "the first lease's install started" },
    );
    const second = await env.cli(
      [...MISSING, "--allow-download", "--agent-id", "agent-b", "--detach"],
      { timeout: 30_000 },
    );
    const firstResult = await first.waitForExit(30_000);

    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
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
