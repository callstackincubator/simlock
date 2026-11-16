import { describe, expect, it } from "vitest";
import { FakeTcpProbe } from "../../ports/index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import {
  adb,
  androidFilesystem,
  devicesListing,
  isGetprop,
  PhoneAdb,
  sdk,
  VERSION_REPLY_41,
} from "./test-physical-handler.js";

const ADDRESS = "192.168.1.5:5555";
const MDNS = "adb-R58Y61A60HN-r7wg2G._adb-tls-connect._tcp";
const NETWORK_LINE = `${ADDRESS} device product:o1s model:SM_G991B transport_id:4`;
const MDNS_LINE = `${MDNS} device product:a16nseea model:SM_A165F transport_id:5`;

// why: the key and the host's platform are the handler's construction options, which the driver surface cannot vary per test.
async function networkHandler(
  listing: string,
  options: { readonly networkDevices?: boolean; readonly platform?: NodeJS.Platform } = {},
) {
  const runner = new PhoneAdb([]);
  runner.devicesOutput = listing;
  const probe = new FakeTcpProbe([]);
  probe.replyWith(VERSION_REPLY_41);
  const handler = new AndroidPhysicalHandler({
    adb,
    baseEnv: { ANDROID_HOME: sdk },
    filesystem: await androidFilesystem(),
    isBareShell: () => false,
    networkDevices: options.networkDevices ?? true,
    platform: options.platform ?? "linux",
    processRunner: runner,
    tcpProbe: probe,
  });
  return { handler, runner };
}

// why: the physical handler is a part of a decomposed module, so its tests reach it directly.
describe("Android physical handler under android.networkDevices: inspectPhysical", () => {
  it("enrols a network phone under its address with its hardware serial, and refuses an unauthorized, offline or unlisted one, one with no hardware serial, and keeps a USB phone as USB", async () => {
    const enrollable = (id: string, hardwareSerial: string) => ({
      apps: ["com.example.kept", "com.example.stray", "com.example.other"],
      class: "phone",
      driverDeviceId: id,
      enrollable: true,
      hardwareSerial,
      model: "SM-G991B",
      osVersion: "34",
    });
    const cases = [
      {
        id: ADDRESS,
        listing: NETWORK_LINE,
        name: "host:port",
        expected: enrollable(ADDRESS, "R58Y61A60HN"),
      },
      {
        id: MDNS,
        listing: MDNS_LINE,
        name: "mDNS name",
        expected: enrollable(MDNS, "R58Y61A60HN"),
      },
      {
        expected: enrollable(ADDRESS, "R58Y61A60HN"),
        id: ADDRESS,
        listing: NETWORK_LINE,
        name: "Windows host:port",
        platform: "win32",
      },
      {
        expected: { enrollable: false, reason: "untrusted" },
        id: ADDRESS,
        listing: `${ADDRESS} unauthorized transport_id:4`,
        name: "unauthorized",
      },
      {
        expected: { enrollable: false, reason: "not-connected" },
        id: ADDRESS,
        listing: `${ADDRESS} offline transport_id:4`,
        name: "offline",
      },
      {
        expected: { enrollable: false, reason: "not-connected" },
        id: ADDRESS,
        listing: "",
        name: "not listed",
      },
      {
        expected: {
          enrollable: false,
          message: /hardware serial \(getprop ro.serialno\)/,
          reason: "unreadable",
        },
        id: ADDRESS,
        listing: NETWORK_LINE,
        name: "empty ro.serialno",
        serial: "",
      },
    ] as const;
    for (const { expected, id, listing, name, ...rest } of cases) {
      const { handler, runner } = await networkHandler(
        devicesListing(...(listing === "" ? [] : [listing])),
        {
          platform: "platform" in rest ? rest.platform : "linux",
        },
      );
      if ("serial" in rest) runner.hardwareSerial = rest.serial;

      const inspection = await handler.inspectPhysical(id);

      expect(inspection, name).toMatchObject(expected);
      expect(runner.rests.flat(), name).not.toContain("connect");
    }

    const usb = await networkHandler(
      devicesListing(`${ADDRESS} device usb:1-1 product:o1s model:SM_G991B transport_id:5`),
    );
    const inspected = await usb.handler.inspectPhysical(ADDRESS);
    expect(inspected).toMatchObject({ driverDeviceId: ADDRESS, enrollable: true });
    expect(inspected).not.toHaveProperty("hardwareSerial");
    expect(usb.runner.rests.flat()).not.toContain("ro.serialno");
  });

  it("refuses an emulator as unsupported-kind whatever its transport, and a network phone that reports neither emulator flag is enrollable", async () => {
    const cases = [
      {
        id: "emulator-5554",
        line: "emulator-5554 device product:sdk transport_id:1",
        name: "emulator-N",
      },
      {
        id: "127.0.0.1:5555",
        line: "127.0.0.1:5555 device transport_id:2",
        name: "ro.boot.qemu",
        boot: "1",
      },
      {
        id: "127.0.0.1:5555",
        line: "127.0.0.1:5555 device transport_id:2",
        name: "ro.kernel.qemu",
        kernel: "1",
      },
    ] as const;
    for (const { id, line, name, ...flags } of cases) {
      const { handler, runner } = await networkHandler(devicesListing(line));
      runner.qemuBoot = "boot" in flags ? flags.boot : "";
      runner.qemuKernel = "kernel" in flags ? flags.kernel : "";

      const inspection = await handler.inspectPhysical(id);

      expect(inspection, name).toMatchObject({ enrollable: false, reason: "unsupported-kind" });
      if (id === "emulator-5554") expect(runner.rests.some(isGetprop), name).toBe(false);
    }

    const phone = await networkHandler(devicesListing(NETWORK_LINE));
    expect(await phone.handler.inspectPhysical(ADDRESS)).toMatchObject({ enrollable: true });

    const off = await networkHandler(
      devicesListing("emulator-5554 device product:sdk transport_id:1"),
      { networkDevices: false },
    );
    expect(await off.handler.inspectPhysical("emulator-5554")).toMatchObject({
      enrollable: false,
      reason: "network-only",
    });
  });
});
