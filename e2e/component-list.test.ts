import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

describe("simlock component list", () => {
  it("lists a component installed with simlock component install as Simlock's, and one scripted as already present as not", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["18.4"],
        componentSizes: { "18.4": 8_000_000_000, "19.0": 9_000_000_000 },
        foreignDevices: { "18.4": 1 },
      },
    });

    const install = await env.cli(["component", "install", "ios", "19.0"]);
    expect(install.code, install.stderr).toBe(0);
    const listed = await env.cli(["component", "list", "--platform", "ios"]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.json).toEqual({
      components: [
        {
          devices: 0,
          foreignDevices: 1,
          installedBySimlock: false,
          platform: "ios",
          sizeBytes: 8_000_000_000,
          version: "18.4",
        },
        {
          devices: 0,
          foreignDevices: 0,
          installedAt: expect.any(Number),
          installedBySimlock: true,
          platform: "ios",
          sizeBytes: 9_000_000_000,
          version: "19.0",
        },
      ],
    });
  });

  it("answers an agent session", async () => {
    const env = await withDaemon();
    await env.driverScript.set({ ios: { availableOsVersions: ["18.4"] } });

    // A credential the daemon rejects falls back to an agent session (with a notice).
    const listed = await env.cli([
      "--token",
      "not-an-admin-credential",
      "component",
      "list",
      "--platform",
      "ios",
    ]);

    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stderr).toContain("connecting as agent");
    expect(listed.json).toMatchObject({ components: [{ platform: "ios", version: "18.4" }] });
  });
});
