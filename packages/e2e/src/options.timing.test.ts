import { describe, expect, it } from "vitest";

import { simlockDevices, type SimlockDevicesOptions } from "./index.js";

const RUN = "/".repeat(100_000);

// why: the bound is real time on a 100 000-slash url, so it lives in the timing project, not in a unit test where a loaded runner would move it.
describe("simlockDevices's url check", () => {
  it("checks a url with a long run of slashes followed by a non-slash within two seconds", () => {
    const started = performance.now();
    simlockDevices({
      url: `https://farm.example.com${RUN}x`,
      token: "agent-token",
      platform: "ios",
      device: "iPhone 17 Pro",
    } as SimlockDevicesOptions);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
