import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import { DriverCatalog } from "./driver-catalog.js";
import { FakeDriver } from "./fake-driver.js";
import {
  encodeScreenFrame,
  encodeScreenMeta,
  type ScreenCapture,
  ScreenNotSupportedError,
  SCREEN_FRAME_TAG,
} from "./screen.js";

const settings = { bitrateKbps: 1500, fps: 30, maxDimension: 720 };
const device = { address: "a", deviceId: "d", driverData: {}, physical: false } as const;

describe("encodeScreenFrame", () => {
  it("prefixes the payload with a big-endian length that counts the tag byte", () => {
    const frame = encodeScreenFrame(SCREEN_FRAME_TAG.keyframe, new Uint8Array([9, 8, 7]));
    expect([...frame]).toEqual([0, 0, 0, 4, SCREEN_FRAME_TAG.keyframe, 9, 8, 7]);
  });

  it("writes a meta frame whose payload is the meta as JSON", () => {
    const frame = encodeScreenMeta({ codec: "h264", fps: 30, height: 720, width: 330 });
    expect(frame[4]).toBe(SCREEN_FRAME_TAG.meta);
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(5)))).toEqual({
      codec: "h264",
      fps: 30,
      height: 720,
      width: 330,
    });
  });
});

describe("DriverCatalog screens", () => {
  it("opens a screen through the driver of the device's platform, with the caller's settings and signal", async () => {
    const opened: string[] = [];
    let passed: { settings: unknown; signal: AbortSignal } | undefined;
    const capture: ScreenCapture = {
      open: async (target, given, signal) => {
        opened.push(target.deviceId);
        passed = { settings: given, signal };
        return { body: new ReadableStream(), close: async () => undefined };
      },
      unavailable: async () => undefined,
    };
    const catalog = new DriverCatalog([
      new FakeDriver({ clock: new FakeClock(), platform: "ios", screenCapture: capture }),
      new FakeDriver({ clock: new FakeClock(), platform: "android" }),
    ]);
    const signal = new AbortController().signal;
    await catalog.openScreen("ios", device, settings, signal);
    expect(opened).toEqual(["d"]);
    expect(passed?.settings).toEqual(settings);
    expect(passed?.signal).toBe(signal);
  });

  it("refuses a platform whose driver offers no screen as not supported", async () => {
    const catalog = new DriverCatalog([
      new FakeDriver({ clock: new FakeClock(), platform: "android" }),
    ]);
    await expect(
      catalog.openScreen("android", device, settings, new AbortController().signal),
    ).rejects.toBeInstanceOf(ScreenNotSupportedError);
  });

  it("reports availability only for drivers that offer a screen, with the reason one cannot", async () => {
    const catalog = new DriverCatalog([
      new FakeDriver({
        clock: new FakeClock(),
        platform: "ios",
        screenCapture: {
          open: async () => {
            throw new Error("unused");
          },
          unavailable: async () => "No capture program at /x",
        },
      }),
      new FakeDriver({ clock: new FakeClock(), platform: "android" }),
    ]);
    expect(await catalog.screenAvailability()).toEqual([
      { platform: "ios", reason: "No capture program at /x" },
    ]);
  });
});
