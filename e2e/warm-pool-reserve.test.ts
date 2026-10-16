import { describe, expect, it } from "vitest";

import { events, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

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

async function makeReadyCalls(env: TestEnv): Promise<number> {
  return (await env.driverLog.calls()).filter((call) => call.operation === "makeReady").length;
}

/** Returns once no boot has started and no device has changed state for two seconds. */
async function untilQuiet(env: TestEnv): Promise<void> {
  const snapshot = async () =>
    `${await makeReadyCalls(env)}:${(await deviceStates(env)).join(",")}`;
  let last = await snapshot();
  let stableSince = Date.now();
  for (let waited = 0; waited < 30_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = await snapshot();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 2_000) return;
  }
  throw new Error("the warm pool never went quiet");
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
    // A slow boot, so a pool boot that wrongly starts is still running, and logged, at the check.
    await env.driverScript.merge({ ios: { latencyMs: { makeReady: 3_000 } } });

    // Two leases still held leave no slot above the reserve, so the first device stays down.
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await env.expectEvents(["lease.released", "device.reclaimed"]);
    await waitFor(async () => !(await deviceStates(env)).includes("reclaiming"), {
      label: "the released device finished its reclaim",
    });
    expect((await deviceStates(env)).filter((state) => state === "shutdown")).toHaveLength(1);
    expect(await makeReadyCalls(env)).toBe(3);
    expect(await eventsNamed(env, "device.ready")).toHaveLength(readyBefore);

    // The check is made; boots now run at full speed, and the test waits for them to end.
    await env.driverScript.merge({ ios: { latencyMs: { makeReady: 0 } } });
    expect((await env.cli(["release", second.lease.id])).code).toBe(0);
    expect((await env.cli(["release", third.lease.id])).code).toBe(0);
    await untilQuiet(env);

    // Exact counts: a third wrongful boot, or a missing one, changes them.
    expect(await makeReadyCalls(env)).toBe(5);
    const states = await deviceStates(env);
    expect(states.filter((state) => state === "ready")).toHaveLength(2);
    expect(states.filter((state) => state === "shutdown")).toHaveLength(1);
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

      // A bound shorter than the test timeout: a request nobody woke fails here, on QUEUE_TIMEOUT.
      const second = await lease(env, "waiter", ["--timeout", "20s"]);

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
