import { describe, expect, it } from "vitest";

import { ANDROID, freeLoopbackPort, listLeases, warmUp, withSharedDaemon } from "./index.js";

describe("warmUp", () => {
  it("when a later warm-up lease fails, rejects and leaves none of the warm-up leases it took held", async () => {
    const env = await withSharedDaemon({
      configOverrides: {
        http: { enabled: false, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      driverScript: {
        android: {
          availableOsVersions: ["34"],
          defaultModels: { phone: ["Pixel 8"] },
          knownModels: ["Pixel 8"],
          modelClasses: { "Pixel 8": "phone" },
        },
      },
    });
    try {
      await warmUp(env, ANDROID, 2);
      expect(await listLeases(env)).toEqual([]);
      await env.driverScript.merge({
        android: { failures: { provision: { type: "BootTimeoutError" } } },
      });

      await expect(warmUp(env, ANDROID, 3)).rejects.toThrow(/Timed out waiting for device to boot/);

      expect(await listLeases(env)).toEqual([]);
    } finally {
      await env.teardown();
    }
  });
});
