import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { Registry, registryOwner } from "../core/index.js";
import { androidDeviceDataTable } from "../drivers/android/index.js";
import { iosDeviceDataTable } from "../drivers/ios/index.js";
import { FakeClock, NodeFilesystem, NodeSqliteOpener, NoopLogger } from "../ports/index.js";
import { openStateDatabase } from "../state/index.js";
import { productionDeviceDataTables } from "./main.js";

describe("the production device-data tables", () => {
  it("a registry restarted on one state.db returns an iOS and an Android device's driverData unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-device-data-"));
    try {
      const clock = new FakeClock(1_000);
      const iosData = {
        deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "simlock-ios-1",
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
        slimMarkToken: "tok",
        slimSignature: "sig",
        udid: "9F2C0000-0000-0000-0000-000000000001",
      };
      const androidData = {
        avdName: "simlock_1",
        configHash: "ab12",
        port: 5554,
        serial: "emulator-5554",
      };
      let next = 0;
      const open = async () =>
        Registry.load({
          clock,
          deviceData: productionDeviceDataTables(),
          eventBus: new EventBus(clock),
          idGenerator: { generate: () => String((next += 1)) },
          state: await openStateDatabase({
            dataDirectory: directory,
            filesystem: new NodeFilesystem(),
            logger: new NoopLogger(),
            oldFiles: [],
            owners: [registryOwner, iosDeviceDataTable, androidDeviceDataTable],
            sqlite: new NodeSqliteOpener(),
            upgradeStep: "remove it.",
          }),
        });
      const registry = await open();
      await registry.registerDevice({
        driverData: iosData,
        driverDeviceId: "drv-ios",
        provisionDuration: 1,
        spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
      });
      await registry.registerDevice({
        driverData: androidData,
        driverDeviceId: "drv-android",
        provisionDuration: 1,
        spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
      });

      const restarted = await open();
      const byDriverId = new Map(
        restarted.snapshot.virtualDevices.map((device) => [
          device.driverDeviceId,
          device.driverData,
        ]),
      );
      expect(byDriverId.get("drv-ios")).toStrictEqual(iosData);
      expect(byDriverId.get("drv-android")).toStrictEqual(androidData);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
