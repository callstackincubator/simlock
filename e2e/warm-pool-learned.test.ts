import { describe, expect, it } from "vitest";

import { events, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

const IOS = {
  availableOsVersions: ["18.4"],
  knownModels: ["iPhone 16"],
  reclaimResult: "shutdown",
} as const;

interface Device {
  readonly id: string;
  readonly state: string;
}

interface Grant {
  readonly lease: { readonly id: string };
  readonly device: Device;
}

async function devices(env: TestEnv): Promise<readonly Device[]> {
  const listed = await env.cli(["list", "--devices"]);
  expect(listed.code, listed.stderr).toBe(0);
  return listed.json as Device[];
}

async function lease(env: TestEnv, agent: string): Promise<Grant> {
  const result = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--agent-id",
    agent,
    "--detach",
  ]);
  expect(result.code, result.stderr).toBe(0);
  return result.json as Grant;
}

async function grants(env: TestEnv): Promise<readonly { payload: { source: string } }[]> {
  return (await events(env.env)).filter((entry) => entry.event === "lease.granted") as never;
}

describe("a worker with no targets keeps the kinds it has leased", () => {
  it("creates nothing while the first lease is held, boots the released device back and keeps it ready past idle.shutdownAfterMs, and grants the next lease of its kind warm", async () => {
    const env = await withDaemon({
      configOverrides: {
        idle: { shutdownAfterMs: 500 },
        limits: { maxRunning: 2, ios: { maxDevices: 2, maxRunning: 2 } },
      },
      driverScript: { ios: IOS },
    });
    const first = await lease(env, "a1");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await devices(env)).toHaveLength(1);

    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await waitFor(async () => (await devices(env)).every((device) => device.state === "ready"), {
      label: "the released device is booted back",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await env.cli(["cleanup"])).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect((await devices(env)).map((device) => device.state)).toEqual(["ready"]);
    const second = await lease(env, "a2");
    expect(second.device.id).toBe(first.device.id);
    expect((await grants(env)).map((entry) => entry.payload.source)).toEqual([
      "provisioned",
      "warm",
    ]);
  });
  it("shuts the device down when the pool is off and boots it again from the record when the pool is back on, before any lease", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 2, ios: { maxDevices: 2, maxRunning: 2 } } },
      driverScript: { ios: IOS },
    });
    const first = await lease(env, "a1");
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await waitFor(async () => (await devices(env)).every((device) => device.state === "ready"), {
      label: "the released device is booted back",
    });

    await env.withConfig({ warmPool: { enabled: false } }, async () => {
      await waitFor(
        async () => (await devices(env)).every((device) => device.state === "shutdown"),
        { label: "the pool being off shuts the device down" },
      );
    });

    await waitFor(
      async () => (await devices(env)).map((device) => device.state).join() === "ready",
      {
        label: "the record boots the device again before any lease",
      },
    );
    expect((await grants(env)).map((entry) => entry.payload.source)).toEqual(["provisioned"]);
  });

  it("boots nothing after simlock nuke --yes and a restart", async () => {
    const env = await withDaemon({
      configOverrides: { limits: { maxRunning: 2, ios: { maxDevices: 2, maxRunning: 2 } } },
      driverScript: { ios: IOS },
    });
    const first = await lease(env, "a1");
    expect((await env.cli(["release", first.lease.id])).code).toBe(0);
    await waitFor(async () => (await devices(env)).every((device) => device.state === "ready"), {
      label: "the released device is booted back",
    });

    const nuked = await env.cli(["nuke", "--yes"]);
    expect(nuked.code, nuked.stderr).toBe(0);
    await env.restartDaemon();
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect((await devices(env)).filter((device) => device.state !== "shutdown")).toEqual([]);
  });
});
