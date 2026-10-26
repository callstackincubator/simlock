import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { DriverCatalog } from "./index.js";
import { FakeDriver, FakeInputFactory } from "./testing.js";

const device = { address: "a", deviceId: "d", driverData: {}, physical: false } as const;
const screen = { height: 2, orientation: "portrait", width: 1 } as const;

describe("DriverCatalog input", () => {
  it("opens a device input through the driver of the device's platform, and says a platform whose driver has none takes no input", async () => {
    const factory = new FakeInputFactory(screen);
    const catalog = new DriverCatalog([
      new FakeDriver({ clock: new FakeClock(), input: factory, platform: "ios" }),
      new FakeDriver({ clock: new FakeClock(), platform: "android" }),
    ]);
    const signal = new AbortController().signal;

    const opened = await catalog.openInput("ios", device, signal);
    expect(opened).toBe(factory.opened[0]);
    expect(await catalog.openInput("android", device, signal)).toEqual({
      unavailable: "android devices take no input",
    });
  });
});
