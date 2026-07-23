import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { FakeDriver } from "./fake-driver.js";
import { DriverCatalog, NoDriverError } from "./driver-catalog.js";

describe("DriverCatalog", () => {
  it("resolves a request through its registered driver", async () => {
    const clock = new FakeClock();
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const catalog = new DriverCatalog([driver]);

    await expect(
      catalog.resolveSpec(
        { model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        { allowDownload: false },
      ),
    ).resolves.toEqual({ model: "iPhone 16", osVersion: "26.5", platform: "ios" });
  });

  it("retains NoDriverError-compatible platform, name, and message", () => {
    const catalog = new DriverCatalog([]);

    expect(() => catalog.get("android")).toThrow(NoDriverError);
    try {
      catalog.get("android");
    } catch (error) {
      expect(error).toMatchObject({
        message: "No driver registered for platform: android",
        name: "NoDriverError",
        platform: "android",
      });
    }
  });
});
