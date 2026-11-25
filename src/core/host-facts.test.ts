import { describe, expect, it } from "vitest";

import { FakeClock } from "../ports/index.js";
import type { DriverToolVersion } from "./driver.js";
import { HOST_FACTS_MAX_AGE_MS, HostFactsReader } from "./host-facts.js";

const SYSTEM = { arch: "arm64", os: "macOS", osVersion: "15.5" };

function scriptedDriver(platform: "ios" | "android") {
  const pending: ((answer: readonly DriverToolVersion[] | Error) => void)[] = [];
  let reads = 0;
  return {
    platform,
    get reads() {
      return reads;
    },
    answer(next: readonly DriverToolVersion[] | Error): void {
      pending.shift()?.(next);
    },
    toolVersions(): Promise<readonly DriverToolVersion[]> {
      reads += 1;
      return new Promise((resolve, reject) => {
        pending.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer)));
      });
    },
  };
}

describe("HostFactsReader", () => {
  it("serves host facts without waiting and re-reads them once older than the maximum age", async () => {
    const clock = new FakeClock(1_000);
    const driver = scriptedDriver("ios");
    const reader = new HostFactsReader({ clock, drivers: [driver], system: SYSTEM });

    expect(reader.current()).toEqual({ ...SYSTEM, tools: [] });
    expect(driver.reads).toBe(1);
    driver.answer([{ build: "16F6", name: "xcode", version: "16.4" }]);
    await reader.refresh();
    expect(reader.current().tools).toEqual([
      { build: "16F6", name: "xcode", platform: "ios", version: "16.4" },
    ]);

    clock.advance(HOST_FACTS_MAX_AGE_MS - 1);
    reader.current();
    expect(driver.reads).toBe(1);

    clock.advance(1);
    expect(reader.current().tools[0]?.version).toBe("16.4");
    reader.current();
    expect(driver.reads).toBe(2);
    driver.answer([{ build: "17A1", name: "xcode", version: "26.0" }]);
    await reader.refresh();
    expect(reader.current().tools[0]?.version).toBe("26.0");
  });

  it("keeps the last tool versions when a re-read fails", async () => {
    const clock = new FakeClock(0);
    const ios = scriptedDriver("ios");
    const android = scriptedDriver("android");
    const reader = new HostFactsReader({ clock, drivers: [ios, android], system: SYSTEM });

    const first = reader.refresh();
    ios.answer([{ name: "xcode", version: "16.4" }]);
    android.answer([{ name: "emulator", version: "35.4.9" }]);
    await first;

    clock.advance(HOST_FACTS_MAX_AGE_MS);
    const second = reader.refresh();
    ios.answer(new Error("xcodebuild hung"));
    android.answer([{ name: "emulator", version: "36.1.0" }]);
    await second;

    expect(reader.current().tools).toEqual([
      { name: "xcode", platform: "ios", version: "16.4" },
      { name: "emulator", platform: "android", version: "36.1.0" },
    ]);
  });

  it("gives up on a driver read that never settles, keeps that driver's last tools, and re-reads the others", async () => {
    const clock = new FakeClock(0);
    const ios = scriptedDriver("ios");
    const android = scriptedDriver("android");
    const reader = new HostFactsReader({ clock, drivers: [ios, android], system: SYSTEM });
    const first = reader.refresh();
    ios.answer([{ name: "xcode", version: "16.4" }]);
    android.answer([{ name: "emulator", version: "35.4.9" }]);
    await first;

    clock.advance(HOST_FACTS_MAX_AGE_MS);
    const second = reader.refresh();
    android.answer([{ name: "emulator", version: "36.1.0" }]);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    clock.advance(30_000);
    await second;

    expect(reader.current().tools).toEqual([
      { name: "xcode", platform: "ios", version: "16.4" },
      { name: "emulator", platform: "android", version: "36.1.0" },
    ]);
    clock.advance(HOST_FACTS_MAX_AGE_MS);
    reader.current();
    expect(ios.reads).toBe(3);
    expect(android.reads).toBe(3);
  });
});
