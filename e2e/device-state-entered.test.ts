import { describe, expect, it } from "vitest";

import { waitForDeviceState, withDaemon } from "./helpers/index.js";

interface Device {
  readonly id: string;
  readonly state: string;
  readonly stateEnteredAt?: number;
}

describe("when a device entered its state", () => {
  it("simlock status --json and simlock list --devices show stateEnteredAt for a ready device", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const held = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "state-entered",
    ]);
    const grant = JSON.parse(await held.firstStdoutLine()) as {
      lease: { id: string };
      device: { driverDeviceId: string };
    };
    expect((await env.cli(["release", grant.lease.id])).code).toBe(0);
    await waitForDeviceState(env, grant.device.driverDeviceId, "ready");
    held.kill("SIGKILL");
    await held.waitForExit(15_000).catch(() => undefined);

    const status = await env.cli(["status", "--json"]);
    const list = await env.cli(["list", "--devices"]);

    expect(status.code).toBe(0);
    expect(list.code).toBe(0);
    for (const devices of [(status.json as { devices: Device[] }).devices, list.json as Device[]]) {
      expect(devices).toHaveLength(1);
      expect(devices[0]?.state).toBe("ready");
      expect(typeof devices[0]?.stateEnteredAt).toBe("number");
    }
  });
});
