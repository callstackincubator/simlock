import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { events, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * `warmPool.targets`: kinds of device the pool keeps booted ahead of demand. What the pool
 * decides is proven in the core; these flows prove what the CLI, the event log and the daemon
 * log show once a daemon runs with a target.
 */

const IPHONE_17 = { count: 1, model: "iPhone 17", osVersion: "26.0", platform: "ios" } as const;
const IOS = { availableOsVersions: ["26.0"], knownModels: ["iPhone 16", "iPhone 17"] };

interface Device {
  readonly id: string;
  readonly driverDeviceId: string;
  readonly state: string;
  readonly spec: { readonly model: string };
}

async function devices(env: TestEnv): Promise<readonly Device[]> {
  const listed = await env.cli(["list", "--devices"]);
  expect(listed.code, listed.stderr).toBe(0);
  return listed.json as Device[];
}

async function untilDevices(
  env: TestEnv,
  matches: (rows: readonly Device[]) => boolean,
  label: string,
  timeout = 30_000,
): Promise<void> {
  let last: readonly Device[] = [];
  await waitFor(
    async () => {
      last = await devices(env);
      return matches(last);
    },
    {
      label: () => `${label}; last saw ${JSON.stringify(last.map((row) => [row.id, row.state]))}`,
      timeout,
    },
  );
}

async function lease(env: TestEnv, agent: string, model: string) {
  const result = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    model,
    "--os",
    "26.0",
    "--agent-id",
    agent,
    "--detach",
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as { readonly lease: { readonly id: string }; readonly device: Device };
}

async function named(env: TestEnv, ...names: string[]) {
  return (await events(env.env)).filter((entry) => names.includes(entry.event));
}

describe("warm pool targets", () => {
  it("with a target of two iPhone 17 and no devices, keeps two ready one boot after the other, and grants the first lease without a boot", async () => {
    const env = await withDaemon({
      configOverrides: {
        warmPool: { maxConcurrentBoots: 1, targets: [{ ...IPHONE_17, count: 2 }] },
      },
      driverScript: { ios: { ...IOS, latencyMs: { makeReady: 300 } } },
    });

    await untilDevices(
      env,
      (rows) => rows.filter((row) => row.state === "ready").length === 2,
      "two iPhone 17 are ready",
    );

    const order = (await named(env, "device.provisioned", "device.ready")).map(
      (entry) => entry.event,
    );
    expect(order).toEqual([
      "device.provisioned",
      "device.ready",
      "device.provisioned",
      "device.ready",
    ]);
    expect((await devices(env)).map((row) => row.spec.model)).toEqual(["iPhone 17", "iPhone 17"]);

    await env.driverLog.clear();
    const granted = await lease(env, "first", "iPhone 17");

    const [leased] = await named(env, "lease.granted");
    expect(leased?.payload).toMatchObject({ source: "warm" });
    expect(granted.device.spec.model).toBe("iPhone 17");
    // The pool then creates a third in the background, to keep two ready.
    await untilDevices(
      env,
      (rows) =>
        rows.filter((row) => row.state === "ready").length === 2 &&
        rows.filter((row) => row.state === "leased").length === 1,
      "a third iPhone 17 is created to keep two ready",
    );
  });

  it("with a target naming an OS that is not installed under downloads.policy always, starts no install and logs the target short with runtime-missing", async () => {
    const env = await withDaemon({
      configOverrides: {
        downloads: { policy: "always" },
        warmPool: { targets: [{ ...IPHONE_17, osVersion: "27.0" }] },
      },
      driverScript: { ios: IOS },
    });

    await waitFor(async () => (await readFile(env.logPath, "utf8")).includes("runtime-missing"), {
      label: "the daemon logs the target as short with runtime-missing",
    });

    expect(await named(env, "component.install-started")).toEqual([]);
    expect(await named(env, "device.provisioned")).toEqual([]);
    expect(
      (await env.driverLog.calls()).filter((call) => call.operation === "installComponent"),
    ).toEqual([]);
  });

  it("keeps a targeted device and a leased non-targeted kind ready past idle.shutdownAfterMs, and shuts a never-leased non-targeted one down as warm-pool", async () => {
    const env = await withDaemon({
      configOverrides: { idle: { shutdownAfterMs: 500 }, warmPool: { targets: [IPHONE_17] } },
      driverScript: { ios: IOS },
    });
    await untilDevices(env, (rows) => rows.some((row) => row.state === "ready"), "one ready");
    // The target's device is leased and released: it served a lease, so the idle timer sees it.
    const targeted = await lease(env, "targeted", "iPhone 17");
    // The pool keeps the count by creating a second one, which no lease will ever reach.
    await untilDevices(
      env,
      (rows) => rows.filter((row) => row.state === "ready").length === 1,
      "a replacement iPhone 17 is ready",
    );
    const replacement = (await devices(env)).find(
      (row) => row.state === "ready" && row.id !== targeted.device.id,
    );
    expect((await env.cli(["release", targeted.lease.id])).code).toBe(0);
    const other = await lease(env, "other", "iPhone 16");
    expect((await env.cli(["release", other.lease.id])).code).toBe(0);

    // The extra iPhone 17 was never leased and no target counts it: the pool shuts that one down.
    await waitFor(
      async () =>
        (await named(env, "device.shutdown")).some(
          (entry) =>
            (entry.payload as { initiator: string; deviceId: string }).initiator === "warm-pool" &&
            (entry.payload as { deviceId: string }).deviceId === replacement?.id,
        ),
      { label: "the pool shuts the never-leased replacement down", timeout: 45_000 },
    );
    expect((await env.cli(["cleanup"])).code).toBe(0);
    const kept = await devices(env);
    expect(kept.find((row) => row.id === targeted.device.id)?.state).toBe("ready");
    expect(kept.find((row) => row.id === other.device.id)?.state).toBe("ready");
    expect(
      (await named(env, "device.shutdown")).filter(
        (entry) => (entry.payload as { deviceId: string }).deviceId === other.device.id,
      ),
    ).toEqual([]);
  });

  it("with a driver that fails every boot, logs the target short with boot-failed after the first creation and holds the next one back", async () => {
    const env = await withDaemon({
      configOverrides: { warmPool: { targets: [IPHONE_17] } },
      driverScript: {
        ios: { ...IOS, failures: { makeReady: { message: "no boot", type: "generic" } } },
      },
    });

    await waitFor(async () => (await named(env, "device.provisioned")).length > 0, {
      label: "the first creation",
      timeout: 30_000,
    });
    // why: a schedule the daemon does not consult lets the next creation follow within
    // milliseconds, so two seconds without one shows the schedule held it back.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const provisioned = await named(env, "device.provisioned");
    expect(provisioned).toHaveLength(1);
    await waitFor(
      async () =>
        (await readFile(env.logPath, "utf8"))
          .split("\n")
          .filter((line) => line.includes("boot-failed"))
          .some(
            (line) =>
              (JSON.parse(line) as { timestamp: number }).timestamp >=
              (provisioned[0]?.timestamp ?? 0),
          ),
      { label: "the target logged short with boot-failed", timeout: 30_000 },
    );
  });

  it("under lease.identity.ios fresh with a target of one, has one ready device before any lease, and after a lease and release has deleted it and readied a new one", async () => {
    const env = await withDaemon({
      configOverrides: {
        lease: { identity: { ios: "fresh" } },
        limits: { ios: { maxDevices: 1, maxRunning: 2 }, maxRunning: 2 },
        warmPool: { targets: [IPHONE_17] },
      },
      driverScript: { ios: IOS },
    });
    await untilDevices(
      env,
      (rows) => rows.length === 1 && rows[0]?.state === "ready",
      "one ready device before any lease",
    );
    const [first] = await devices(env);

    const granted = await lease(env, "fresh", "iPhone 17");
    expect(granted.device.id).toBe(first?.id);
    expect((await env.cli(["release", granted.lease.id])).code).toBe(0);

    await untilDevices(
      env,
      (rows) =>
        rows.find((row) => row.id === first?.id)?.state === "deleted" &&
        rows.filter((row) => row.state === "ready" && row.id !== first?.id).length === 1,
      "the spent device is deleted and a new one is ready",
    );
  });
});
