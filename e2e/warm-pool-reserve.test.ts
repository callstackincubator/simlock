import { describe, expect, it } from "vitest";

import { events, waitFor, waitForDeviceState, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * `warmPool.reserveRunning`, and a request that arrives while the warm pool is booting a device
 * that serves it. Both are decided in the core; these flows only prove what the CLI shows.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: { readonly id: string; readonly driverDeviceId: string };
}

async function lease(env: TestEnv, agent: string, extra: readonly string[] = []): Promise<Grant> {
  const result = await env.cli([...LEASE, "--agent-id", agent, ...extra, "--detach"]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

async function deviceStates(env: TestEnv): Promise<readonly string[]> {
  const listed = await env.cli(["list", "--devices"]);
  return (listed.json as { readonly state: string }[]).map((device) => device.state);
}

async function eventsNamed(env: TestEnv, name: string): Promise<readonly { payload: unknown }[]> {
  return (await events(env.env)).filter((entry) => entry.event === name);
}

describe("warm pool reserve and requests that wait for a booting device", () => {
  it("simlock config prints warmPool.reserveRunning with both platforms at 0 by default", async () => {
    const env = await withDaemon({ driverScript: { ios: IOS } });

    const config = await env.cli(["config", "get", "warmPool.reserveRunning"]);

    expect(config.code, config.stderr).toBe(0);
    expect(config.json).toEqual({ android: 0, ios: 0 });
  });

  it("with reserveRunning.ios 1 and an iOS running limit of 3, three released leases leave two devices warm and one shut down", async () => {
    const env = await withDaemon({
      configOverrides: {
        limits: { maxRunning: 3, ios: { maxDevices: 3, maxRunning: 3 } },
        warmPool: { reserveRunning: { ios: 1 } },
      },
      driverScript: { ios: { ...IOS, reclaimResult: "shutdown" } },
    });
    const [first, second, third] = [
      await lease(env, "agent-a"),
      await lease(env, "agent-b"),
      await lease(env, "agent-c"),
    ];
    const readyBefore = (await eventsNamed(env, "device.ready")).length;

    // Two leases still held leave no slot above the reserve, so the first device stays down.
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await env.expectEvents(["lease.released", "device.reclaimed"]);
    await waitForDeviceState(env, first.device.driverDeviceId, "shutdown");
    expect(await eventsNamed(env, "device.ready")).toHaveLength(readyBefore);

    expect((await env.cli(["release", second.lease.id])).code).toBe(0);
    expect((await env.cli(["release", third.lease.id])).code).toBe(0);

    await waitFor(
      async () => (await deviceStates(env)).filter((state) => state === "ready").length === 2,
      {
        label: "two devices are warm",
      },
    );
    expect((await deviceStates(env)).filter((state) => state === "shutdown")).toHaveLength(1);
    expect(await eventsNamed(env, "device.ready")).toHaveLength(readyBefore + 2);
    const status = await env.cli(["status", "--json"]);
    expect(status.json).toMatchObject({ capacity: { ios: { warm: 2 } } });
  });

  describe("while the warm pool boots a released device", () => {
    async function releasedAndBooting(env: TestEnv): Promise<Grant> {
      const first = await lease(env, "holder");
      await env.driverScript.merge({ ios: { latencyMs: { makeReady: 3_000 } } });
      expect((await env.cli(["release", first.lease.id])).code).toBe(0);
      await waitFor(
        async () =>
          (await env.driverLog.calls()).filter((call) => call.operation === "makeReady").length ===
          2,
        { label: "the warm pool's boot has started" },
      );
      return first;
    }

    it("a lease for that device is granted it when it is ready, with no device.provisioned for it", async () => {
      const env = await withDaemon({
        driverScript: { ios: { ...IOS, reclaimResult: "shutdown" } },
      });
      const first = await releasedAndBooting(env);

      const second = await lease(env, "waiter");

      expect(second.device.id).toBe(first.device.id);
      expect(await eventsNamed(env, "device.provisioned")).toHaveLength(1);
      expect(await eventsNamed(env, "device.ready")).toHaveLength(2);
    });

    it("the same lease with --no-wait provisions its own device", async () => {
      const env = await withDaemon({
        driverScript: { ios: { ...IOS, reclaimResult: "shutdown" } },
      });
      const first = await releasedAndBooting(env);

      const second = await lease(env, "waiter", ["--no-wait"]);

      expect(second.device.id).not.toBe(first.device.id);
      expect(await eventsNamed(env, "device.provisioned")).toHaveLength(2);
    });
  });
});
