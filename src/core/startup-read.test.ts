import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "../ports/index.js";
import type { Driver, DriverReality, ObservedDevice } from "./driver.js";
import type { Platform } from "./domain.js";
import { readStartup, STARTUP_READ_LIMIT_MS } from "./startup-read.js";

function observed(deviceId: string): ObservedDevice {
  return { deviceId, driverData: {}, runState: "running" } as ObservedDevice;
}

function reality(...ids: string[]): DriverReality {
  return { devices: ids.map(observed), processes: [] };
}

function driver(platform: Platform, listManaged: () => Promise<DriverReality>) {
  const list = vi.fn(listManaged);
  return { driver: { listManaged: list, platform } as unknown as Driver, list };
}

describe("readStartup", () => {
  it("calls listManaged once per driver and reports each platform's devices", async () => {
    const ios = driver("ios", async () => reality("a"));
    const android = driver("android", async () => reality("b"));

    const read = await readStartup({
      clock: new FakeClock(0),
      drivers: [ios.driver, android.driver],
    });

    expect(ios.list).toHaveBeenCalledTimes(1);
    expect(android.list).toHaveBeenCalledTimes(1);
    expect(read.reality("ios")).toEqual(reality("a"));
    expect(read.reality("android")).toEqual(reality("b"));
    expect(read.isReadable("ios")).toBe(true);
  });

  it("reads a platform with no driver as unreadable", async () => {
    const ios = driver("ios", async () => reality("a"));

    const read = await readStartup({ clock: new FakeClock(0), drivers: [ios.driver] });

    expect(read.isReadable("android")).toBe(false);
    expect(read.reality("android")).toBeUndefined();
    expect(read.isReadable("ios")).toBe(true);
  });

  it("reads a platform whose listManaged throws as unreadable and still reads the other", async () => {
    const ios = driver("ios", async () => {
      throw new Error("simctl broke");
    });
    const android = driver("android", async () => reality("b"));

    const read = await readStartup({
      clock: new FakeClock(0),
      drivers: [ios.driver, android.driver],
    });

    expect(read.isReadable("ios")).toBe(false);
    expect(read.reality("android")).toEqual(reality("b"));
  });

  it("reads a platform whose listManaged has not answered after 60 seconds as unreadable, and goes on", async () => {
    const clock = new FakeClock(0);
    const ios = driver("ios", () => new Promise<DriverReality>(() => undefined));
    const android = driver("android", async () => reality("b"));

    const pending = readStartup({ clock, drivers: [ios.driver, android.driver] });
    await vi.waitFor(() => expect(ios.list).toHaveBeenCalledTimes(1));
    clock.advance(STARTUP_READ_LIMIT_MS);
    const read = await pending;

    expect(STARTUP_READ_LIMIT_MS).toBe(60_000);
    expect(read.isReadable("ios")).toBe(false);
    expect(read.reality("android")).toEqual(reality("b"));
  });

  it("keeps waiting for a platform that has been silent for less than 60 seconds", async () => {
    const clock = new FakeClock(0);
    let answer: (value: DriverReality) => void = () => undefined;
    const ios = driver("ios", () => new Promise<DriverReality>((resolve) => (answer = resolve)));
    let settled = false;

    const pending = readStartup({ clock, drivers: [ios.driver] }).then((read) => {
      settled = true;
      return read;
    });
    await vi.waitFor(() => expect(ios.list).toHaveBeenCalledTimes(1));
    clock.advance(STARTUP_READ_LIMIT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    answer(reality("a"));
    const read = await pending;

    expect(read.reality("ios")).toEqual(reality("a"));
    expect(clock.pendingTimerCount).toBe(0);
  });
});
