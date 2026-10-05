import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

interface StatusDevice {
  readonly id: string;
  readonly mode: "slim" | "full";
  readonly servesDefaultMode: boolean;
}

describe("status shows whether a device serves a request with no mode", () => {
  it("shows mode and servesDefaultMode for every device, true only for the pool the worker's default draws from", async () => {
    const env = await withDaemon({
      configOverrides: { ios: { defaultMode: "slim" } },
      driverScript: {
        ios: {
          availableOsVersions: ["26.0"],
          knownModels: ["iPhone 16"],
          slimmableOsVersions: ["26.0"],
        },
      },
    });
    const lease = async (agentId: string, mode: "slim" | "full") => {
      const leased = await env.cli([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--mode",
        mode,
        "--agent-id",
        agentId,
        "--detach",
      ]);
      expect(leased.code, leased.stderr).toBe(0);
      return (leased.json as { device: { id: string } }).device.id;
    };
    const slimId = await lease("slim-agent", "slim");
    const fullId = await lease("full-agent", "full");

    const status = await env.cli(["status", "--json"]);
    expect(status.code, status.stderr).toBe(0);
    const devices = (status.json as { devices: StatusDevice[] }).devices;
    expect(
      devices.map(({ id, mode, servesDefaultMode }) => ({ id, mode, servesDefaultMode })),
    ).toEqual(
      expect.arrayContaining([
        { id: slimId, mode: "slim", servesDefaultMode: true },
        { id: fullId, mode: "full", servesDefaultMode: false },
      ]),
    );
    expect(devices).toHaveLength(2);

    const human = await env.cli(["status"]);
    expect(human.stdout).toContain(`Device ${slimId}: leased, mode slim, serves default mode: yes`);
    expect(human.stdout).toContain(`Device ${fullId}: leased, mode full, serves default mode: no`);
  });
});
