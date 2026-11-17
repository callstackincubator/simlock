import { describe, expect, it } from "vitest";
import { FakeTcpProbe } from "../../ports/index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import {
  sdk,
  adb,
  PHONE,
  VERSION_REPLY_41,
  PhoneAdb,
  androidFilesystem,
  devicesListing,
} from "./test-physical-handler.js";

// why: the physical handler is a part of a decomposed module, so its tests reach it directly.
describe("Android physical handler on Windows", () => {
  // why: adb on Windows lists no `usb:` path, which the driver surface cannot fake per host;
  // the handler is built straight with `platform: "win32"`.
  async function windowsHandler(listing: string, platform: NodeJS.Platform = "win32") {
    const runner = new PhoneAdb([]);
    runner.devicesOutput = listing;
    const probe = new FakeTcpProbe([]);
    probe.replyWith(VERSION_REPLY_41);
    return new AndroidPhysicalHandler({
      adb,
      baseEnv: { ANDROID_HOME: sdk },
      filesystem: await androidFilesystem(),
      isBareShell: () => false,
      platform,
      processRunner: runner,
      tcpProbe: probe,
    });
  }

  const WINDOWS_LINE = `${PHONE} device product:a70qxtc model:SM_A705MN device:a70q transport_id:1`;

  it("enrols a phone adb lists with no usb: path, as adb on Windows lists every USB device", async () => {
    const handler = await windowsHandler(devicesListing(WINDOWS_LINE));

    await expect(handler.inspectPhysical(PHONE)).resolves.toMatchObject({
      driverDeviceId: PHONE,
      enrollable: true,
    });
  });

  it("still refuses the same listing off Windows, where a USB device always has a usb: path", async () => {
    const handler = await windowsHandler(devicesListing(WINDOWS_LINE), "linux");

    await expect(handler.inspectPhysical(PHONE)).resolves.toMatchObject({
      enrollable: false,
      reason: "network-only",
    });
  });

  it.each([
    ["win32", { driverDeviceId: PHONE, osVersion: "34", present: true }],
    ["linux", { driverDeviceId: PHONE, present: false, reason: "not-present" }],
  ] as const)(
    "lists an enrolled phone with no usb: path on %s as the USB rule of that host says",
    async (platform, expected) => {
      const handler = await windowsHandler(devicesListing(WINDOWS_LINE), platform);

      await expect(handler.listPresentPhysical([{ driverDeviceId: PHONE }])).resolves.toEqual([
        expected,
      ]);
    },
  );

  it.each([
    ["a host:port", "192.168.1.5:5555"],
    ["an mDNS service", "adb-R58M123ABC-x1Yz2W._adb-tls-connect._tcp"],
    ["an emulator", "emulator-5554"],
  ])("refuses %s serial on Windows as network-only", async (_kind, serial) => {
    const handler = await windowsHandler(
      devicesListing(`${serial} device product:o1s transport_id:5`),
    );

    await expect(handler.inspectPhysical(serial)).resolves.toMatchObject({
      enrollable: false,
      reason: "network-only",
    });
  });
});
