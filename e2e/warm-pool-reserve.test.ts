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

  it("with reserveRunning.ios 1 and an iOS running limit of 3, three released leases are deleted and leave two new devices warm", async () => {
    const env = await withDaemon({
      configOverrides: {
        limits: { maxRunning: 3, ios: { maxDevices: 3, maxRunning: 3 } },
        warmPool: { reserveRunning: { ios: 1 } },
      },
      driverScript: { ios: IOS },
    });
    const [first, second, third] = [
      await lease(env, "agent-a"),
      await lease(env, "agent-b"),
      await lease(env, "agent-c"),
    ];
    const readyBefore = (await eventsNamed(env, "device.ready")).length;
    // A slow boot, so a pool boot that wrongly starts is still running, and logged, at the check.
    await env.driverScript.merge({ ios: { latencyMs: { makeReady: 3_000 } } });

    // why: two leases still held leave no slot above the reserve, so no device is made for the first.
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await env.expectEvents(["lease.released", "device.deleted"]);
    expect((await deviceStates(env)).filter((state) => state === "deleted")).toHaveLength(1);
    expect(await deviceStates(env)).not.toContain("provisioning");
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
    expect(states.filter((state) => state === "deleted")).toHaveLength(3);
    expect(states).not.toContain("shutdown");
    expect(await eventsNamed(env, "device.ready")).toHaveLength(readyBefore + 2);
    const status = await env.cli(["status", "--json"]);
    expect(status.json).toMatchObject({ capacity: { ios: { warm: 2 } } });
  });

  it("five detached leases of one kind queued behind a booting device, with maxConcurrentBoots 3, start three makeReady calls at once, not four, then the fourth once one is ready, and every lease is granted, leaving one spare ready", async () => {
    const env = await withDaemon({
      configOverrides: {
        limits: { maxRunning: 10, ios: { maxDevices: 10, maxRunning: 10 } },
        warmPool: { maxConcurrentBoots: 3 },
      },
      driverScript: { ios: IOS },
    });
    // why: the first lease's kind is learned, so the pool boots a spare while it is held (ADR 0069);
    // the slow boot is set first so that spare is still booting when the five leases arrive.
    await env.driverScript.merge({ ios: { latencyMs: { makeReady: 4_000 } } });
    const warm = await lease(env, "warm", ["--timeout", "60s"]);
    await waitFor(async () => (await makeReadyCalls(env)) === 2, {
      label: "the warm pool's boot of the spare for the held lease has started",
    });
    expect((await env.cli(["release", warm.lease.id])).code).toBe(0);

    const grants = ["a1", "a2", "a3", "a4", "a5"].map((agent) =>
      lease(env, agent, ["--timeout", "60s"]),
    );
    // why: the warm pool's boot of the spare counts among the three.
    await waitFor(async () => (await makeReadyCalls(env)) === 4, {
      label: "two more boots are running beside the warm pool's",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await makeReadyCalls(env)).toBe(4);

    const granted = await Promise.all(grants);
    await untilQuiet(env);

    expect(new Set(granted.map((grant) => grant.device.id)).size).toBe(5);
    // why: five held copies leave one spare ready, the seventh boot (ADR 0069).
    expect(await makeReadyCalls(env)).toBe(7);
    expect((await deviceStates(env)).filter((state) => state === "leased")).toHaveLength(5);
    // why: the boots are still slow, so the spare may still be booting when the pool goes quiet.
    await waitFor(
      async () => (await deviceStates(env)).filter((state) => state === "ready").length === 1,
      { label: "the one spare is ready" },
    );
  });

  describe("while the warm pool boots the spare of a released lease's kind", () => {
    async function releasedAndReplacing(env: TestEnv): Promise<Grant> {
      // why: the holder's kind is learned, so the pool boots a spare while it is held (ADR 0069);
      // the slow boot is set first so the spare is still booting when the holder is released.
      await env.driverScript.merge({ ios: { latencyMs: { makeReady: 3_000 } } });
      const first = await lease(env, "holder", ["--timeout", "20s"]);
      await waitFor(async () => (await makeReadyCalls(env)) === 2, {
        label: "the warm pool's boot of the spare has started",
      });
      expect((await env.cli(["release", first.lease.id])).code).toBe(0);
      return first;
    }

    it("a lease for that spare is granted it when it is ready, and the spare is the second device provisioned, not one the lease provisioned itself", async () => {
      const env = await withDaemon({
        driverScript: { ios: IOS },
      });
      const first = await releasedAndReplacing(env);

      // A bound shorter than the test timeout: a request nobody woke fails here, on QUEUE_TIMEOUT.
      const second = await lease(env, "waiter", ["--timeout", "20s"]);

      // why: the pool's next spare, made once the waiter holds the first, may be provisioned too; the
      // waiter's own provision would be the second row instead of the pool's spare.
      const provisioned = await eventsNamed(env, "device.provisioned");
      expect(second.device.id).not.toBe(first.device.id);
      expect(provisioned[0]?.payload).toMatchObject({ deviceId: first.device.id });
      expect(provisioned[1]?.payload).toMatchObject({ deviceId: second.device.id });
    });

    it("the same lease with --no-wait provisions its own device", async () => {
      const env = await withDaemon({
        driverScript: { ios: IOS },
      });
      const first = await releasedAndReplacing(env);

      const second = await lease(env, "waiter", ["--no-wait"]);

      expect(second.device.id).not.toBe(first.device.id);
      expect(await eventsNamed(env, "device.provisioned")).toHaveLength(3);
    });
  });
});
