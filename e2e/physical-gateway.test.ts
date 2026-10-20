import { describe, expect, it } from "vitest";

import type { ScriptedPhysicalDevice } from "./fake-driver/types.js";
import { type TestEnv, waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";
import {
  PHYSICAL_AGENT,
  PHYSICAL_MODEL,
  PHYSICAL_OS,
  READY,
  seedPhysicalState,
} from "./helpers/physical-state.js";

const ENROLLED = ["com.example.mail"] as const;
const AGENT_APP = "com.agent.tool";

function iosScript(installed?: readonly string[]) {
  const phone: ScriptedPhysicalDevice = {
    apps: ENROLLED,
    class: "phone",
    ids: [READY.driverDeviceId],
    model: PHYSICAL_MODEL,
    osVersion: PHYSICAL_OS,
    ...(installed === undefined ? {} : { installedApps: installed }),
  };
  return {
    availableOsVersions: [PHYSICAL_OS],
    defaultModels: { phone: ["iPhone 16"] },
    knownModels: [PHYSICAL_MODEL, "iPhone 16"],
    modelClasses: { "iPhone 16": "phone", [PHYSICAL_MODEL]: "phone" },
    physicalDevices: [phone],
  } as const;
}

interface Row {
  readonly id: string;
  readonly state: string;
  readonly physical?: boolean;
  readonly workerId?: string;
}

async function fleetWithIphone(): Promise<{ gateway: TestEnv; worker: TestEnv }> {
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    configOverrides: { http: { host: "127.0.0.1", port } },
    role: "gateway",
    driver: "none",
  }));
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const worker = await withDaemon({
    agentId: PHYSICAL_AGENT,
    configOverrides: {
      gateway: { label: "worker-p", token: secret, url: `ws://127.0.0.1:${String(port)}` },
    },
    driverScript: { ios: iosScript() },
    mode: "auto",
  });
  await seedPhysicalState(worker, [{ ...READY, enrolledApps: ENROLLED }]);
  const started = await worker.startDaemon();
  expect(started.code, started.stderr).toBe(0);
  await waitFor(
    async () => {
      const status = (await gateway.cli(["status", "--json"])).json as { devices?: Row[] };
      return (status.devices ?? []).some((row) => row.id === READY.id);
    },
    { label: "the gateway lists the worker's iPhone", timeout: 30_000 },
  );
  return { gateway, worker };
}

describe("a gateway with one worker that holds an enrolled iPhone", () => {
  it("through a gateway with one worker, lease --platform ios --physical is granted the worker's enrolled iPhone, and its release uninstalls the agent's app on the worker", async () => {
    const { gateway, worker } = await fleetWithIphone();

    const granted = await gateway.cli([
      "lease",
      "--platform",
      "ios",
      "--physical",
      "--agent-id",
      "gateway-agent",
      "--detach",
    ]);
    expect(granted.code, granted.stderr).toBe(0);
    const grant = granted.json as { lease: { id: string; worker: { id: string } }; device: Row };
    expect(grant.device).toMatchObject({ id: READY.id, physical: true });
    expect(grant.lease.worker.id).toEqual(expect.any(String));

    await worker.driverScript.set({ ios: iosScript([...ENROLLED, AGENT_APP]) });
    const released = await gateway.cli(["release", grant.lease.id]);
    expect(released.code, released.stderr).toBe(0);

    await waitFor(
      async () => (await worker.driverLog.calls()).some((call) => call.operation === "uninstall"),
      { label: "the worker uninstalls the agent's app", timeout: 30_000 },
    );
    const uninstalls = (await worker.driverLog.calls()).filter(
      (call) => call.operation === "uninstall",
    );
    expect(uninstalls.map((call) => call.arguments)).toEqual([[READY.driverDeviceId, AGENT_APP]]);
  });
});
