import { describe, expect, it } from "vitest";

import { events, type TestEnv, withDaemon } from "./helpers/index.js";

async function removeCalls(env: TestEnv): Promise<unknown[]> {
  return (await env.driverLog.calls())
    .filter((call) => call.operation === "removeComponent")
    .map((call) => call.arguments);
}

/** A daemon whose iOS driver has 18.4 on the machine and 19.0 installed by Simlock. */
async function withSimlockInstall(): Promise<TestEnv> {
  const env = await withDaemon();
  await env.driverScript.set({
    ios: {
      availableOsVersions: ["18.4"],
      componentSizes: { "19.0": 9_000_000_000 },
      knownModels: ["iPhone 16"],
    },
  });
  const install = await env.cli(["component", "install", "ios", "19.0"]);
  expect(install.code, install.stderr).toBe(0);
  await env.driverLog.clear();
  return env;
}

describe("simlock component remove", () => {
  it("removes a component Simlock installed: the catalog and component list no longer show it, and component.removed names who asked", async () => {
    const env = await withSimlockInstall();

    const removed = await env.cli(["component", "remove", "ios", "19.0", "--yes"], {
      env: { SIMLOCK_AGENT_ID: "operator-221" },
    });

    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.json).toEqual({
      outcome: "removed",
      platform: "ios",
      sizeBytes: 9_000_000_000,
      version: "19.0",
    });
    expect(await removeCalls(env)).toHaveLength(1);
    const catalog = await env.cli(["catalog", "--platform", "ios", "--json"]);
    expect(catalog.json).toMatchObject({ platforms: [{ runtimes: ["18.4"] }] });
    const listed = await env.cli(["component", "list", "--platform", "ios"]);
    expect(listed.json).toMatchObject({ components: [{ version: "18.4" }] });
    expect((listed.json as { components: unknown[] }).components).toHaveLength(1);
    const removedEvents = (await events(env.env)).filter(
      (entry) => entry.event === "component.removed",
    );
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0]?.payload).toMatchObject({
      componentId: "19.0",
      platform: "ios",
      requesterId: "operator-221",
      sizeBytes: 9_000_000_000,
      version: "19.0",
    });
  });

  it("answers a dry run with would-remove and the size, and removes nothing", async () => {
    const env = await withSimlockInstall();

    const dryRun = await env.cli(["component", "remove", "ios", "19.0", "--dry-run"]);

    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(dryRun.json).toEqual({
      outcome: "would-remove",
      platform: "ios",
      sizeBytes: 9_000_000_000,
      version: "19.0",
    });
    expect(await removeCalls(env)).toEqual([]);
    const listed = await env.cli(["component", "list", "--platform", "ios"]);
    expect(listed.json).toMatchObject({
      components: [{ version: "18.4" }, { installedBySimlock: true, version: "19.0" }],
    });
  });

  it("refuses a component Simlock did not install with COMPONENT_NOT_OWNED and exit 12, removing nothing", async () => {
    const env = await withSimlockInstall();

    const result = await env.cli(["component", "remove", "ios", "18.4", "--yes"]);

    expect(result.code, result.stderr).toBe(12);
    expect(result.stdout).toBe("");
    expect(result.error?.code).toBe("COMPONENT_NOT_OWNED");
    expect(await removeCalls(env)).toEqual([]);
  });

  it("refuses a component a leased device uses with COMPONENT_IN_USE and exit 12, removing nothing", async () => {
    const env = await withSimlockInstall();
    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "19.0",
      "--agent-id",
      "agent-a",
      "--detach",
    ]);
    expect(lease.code, lease.stderr).toBe(0);

    const result = await env.cli(["component", "remove", "ios", "19.0", "--yes"]);

    expect(result.code, result.stderr).toBe(12);
    expect(result.error?.code).toBe("COMPONENT_IN_USE");
    expect(await removeCalls(env)).toEqual([]);
  });

  it("refuses a component a foreign device uses with COMPONENT_IN_USE, removing nothing", async () => {
    const env = await withSimlockInstall();
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["18.4"],
        foreignDevices: { "19.0": 1 },
        knownModels: ["iPhone 16"],
      },
    });

    const result = await env.cli(["component", "remove", "ios", "19.0", "--yes"]);

    expect(result.code, result.stderr).toBe(12);
    expect(result.error?.code).toBe("COMPONENT_IN_USE");
    expect(await removeCalls(env)).toEqual([]);
  });

  it("refuses an agent session with FORBIDDEN, removing nothing", async () => {
    const env = await withSimlockInstall();

    // A credential the daemon rejects falls back to an agent session (with a notice).
    const result = await env.cli([
      "--token",
      "not-an-admin-credential",
      "component",
      "remove",
      "ios",
      "19.0",
      "--yes",
    ]);

    expect(result.code, result.stderr).toBe(1);
    expect(result.error?.code).toBe("FORBIDDEN");
    expect(await removeCalls(env)).toEqual([]);
  });
});
