import { describe, expect, it } from "vitest";
import { PassthroughRefusedError } from "../../core/index.js";
import { FakeTcpProbe, FakeTcpStreamConnector } from "../../ports/index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import {
  adb,
  androidFilesystem,
  devicesListing,
  FAILED,
  TIMED_OUT,
  PHONE,
  passthroughOf,
  rejectionOf,
  restOf,
  world,
  isGetprop,
  PhoneAdb,
  sdk,
  USB_LINE,
  VERSION_REPLY_40,
  VERSION_REPLY_41,
} from "./test-physical-handler.js";

const ADDRESS = "192.168.1.5:5555";
const MDNS = "adb-R58Y61A60HN-r7wg2G._adb-tls-connect._tcp";
const NETWORK_LINE = `${ADDRESS} device product:o1s model:SM_G991B transport_id:4`;
const MDNS_LINE = `${MDNS} device product:a16nseea model:SM_A165F transport_id:5`;

// why: the key and the host's platform are the handler's construction options, which the driver surface cannot vary per test.
async function networkHandler(
  listing: string,
  options: {
    readonly networkDevices?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly reply?: string;
  } = {},
) {
  const runner = new PhoneAdb([]);
  runner.devicesOutput = listing;
  const probe = new FakeTcpProbe([]);
  probe.replyWith(options.reply ?? VERSION_REPLY_41);
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

describe("Android physical handler under android.networkDevices: listPresentPhysical", () => {
  const enrolled = { driverDeviceId: ADDRESS, hardwareSerial: "R58Y61A60HN" };

  it("reads an enrolled network phone present only when the phone answering has the recorded hardware serial", async () => {
    const present = await networkHandler(devicesListing(NETWORK_LINE));
    expect(await present.handler.listPresentPhysical([enrolled])).toEqual([
      { driverDeviceId: ADDRESS, osVersion: "34", present: true },
    ]);

    const other = await networkHandler(devicesListing(NETWORK_LINE));
    other.runner.hardwareSerial = "ZZZ999";
    other.runner.calls.length = 0;
    expect(await other.handler.listPresentPhysical([enrolled])).toEqual([
      { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
    ]);
    expect(other.runner.rests.at(-1)).toEqual(["-s", ADDRESS, "shell", "getprop", "ro.serialno"]);

    const unauthorized = await networkHandler(
      devicesListing(`${ADDRESS} unauthorized transport_id:4`),
    );
    expect(await unauthorized.handler.listPresentPhysical([enrolled])).toEqual([
      { driverDeviceId: ADDRESS, present: false, reason: "untrusted" },
    ]);

    for (const failure of [FAILED, TIMED_OUT]) {
      const unreadable = await networkHandler(devicesListing(NETWORK_LINE));
      unreadable.runner.override((rest) => (rest.includes("ro.serialno") ? failure : undefined));
      expect(await unreadable.handler.listPresentPhysical([enrolled])).toEqual([
        { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
      ]);
    }

    const usb = await networkHandler(devicesListing(USB_LINE));
    expect(await usb.handler.listPresentPhysical([{ driverDeviceId: PHONE }])).toEqual([
      { driverDeviceId: PHONE, osVersion: "34", present: true },
    ]);
    expect(usb.runner.rests.flat()).not.toContain("ro.serialno");

    const off = await networkHandler(devicesListing(NETWORK_LINE), { networkDevices: false });
    expect(await off.handler.listPresentPhysical([enrolled])).toEqual([
      { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
    ]);
    expect(off.runner.rests.flat()).not.toContain("connect");
  });
});

describe("Android physical handler under android.networkDevices: reconnecting", () => {
  const other = "192.168.1.6:5555";
  const third = "192.168.1.7:5555";
  const listed = (...ids: string[]) =>
    devicesListing(...ids.map((id) => `${id} device product:o1s transport_id:4`));
  const record = (driverDeviceId: string) => ({ driverDeviceId, hardwareSerial: "R58Y61A60HN" });
  const connects = (runner: PhoneAdb) => runner.rests.filter((rest) => rest[0] === "connect");
  const listings = (runner: PhoneAdb) => runner.rests.filter((rest) => rest[0] === "devices");

  // why: a connect that "succeeds" only adds the phone to the next listing, as adb's own output is ignored.
  function connectAdds(runner: PhoneAdb, reachable: readonly string[], output: string) {
    let inFlight = 0;
    let mostInFlight = 0;
    runner.override((rest) => {
      if (rest[0] !== "connect") return undefined;
      const address = rest[1] ?? "";
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise((resolve) => {
        setImmediate(() => {
          inFlight -= 1;
          if (reachable.includes(address)) {
            runner.devicesOutput += `${address} device product:o1s transport_id:9\n`;
          }
          resolve({ code: 0, stderr: "", stdout: output });
        });
      });
    });
    return { mostInFlight: () => mostInFlight };
  }

  it("runs one adb connect with a 10 s limit for each enrolled host:port the listing lacks, all together, then lists once more and judges by that listing alone", async () => {
    const reconnected = await networkHandler(listed());
    const only = connectAdds(reconnected.runner, [ADDRESS], `connected to ${ADDRESS}\n`);
    expect(await reconnected.handler.listPresentPhysical([record(ADDRESS)])).toEqual([
      { driverDeviceId: ADDRESS, osVersion: "34", present: true },
    ]);
    expect(connects(reconnected.runner)).toEqual([["connect", ADDRESS]]);
    expect(
      reconnected.runner.commands.find((call) => restOf(call)[0] === "connect")?.options.timeoutMs,
    ).toBe(10_000);
    expect(listings(reconnected.runner)).toHaveLength(2);
    expect(only.mostInFlight()).toBe(1);

    const failed = await networkHandler(listed());
    connectAdds(failed.runner, [], `failed to connect to '${ADDRESS}': Connection refused\n`);
    expect(await failed.handler.listPresentPhysical([record(ADDRESS)])).toEqual([
      { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
    ]);

    const wrongExit = await networkHandler(listed());
    connectAdds(wrongExit.runner, [ADDRESS], `failed to connect to '${ADDRESS}'\n`);
    expect(await wrongExit.handler.listPresentPhysical([record(ADDRESS)])).toMatchObject([
      { present: true },
    ]);

    const many = await networkHandler(listed());
    const together = connectAdds(many.runner, [], "");
    await many.handler.listPresentPhysical([ADDRESS, other, third].map(record));
    expect(connects(many.runner)).toHaveLength(3);
    expect(together.mostInFlight()).toBe(3);
    expect(listings(many.runner)).toHaveLength(2);

    const timedOut = await networkHandler(listed());
    timedOut.runner.override((rest) => (rest[0] === "connect" ? TIMED_OUT : undefined));
    expect(await timedOut.handler.listPresentPhysical([record(ADDRESS)])).toEqual([
      { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
    ]);
  });

  it("runs no adb connect for a listed host:port, an mDNS name, a USB ID, a key that is off or a protocol mismatch", async () => {
    const cases = [
      { enrolled: [record(ADDRESS)], listing: listed(ADDRESS), name: "listed" },
      { enrolled: [record(MDNS)], listing: listed(), name: "mDNS name" },
      { enrolled: [{ driverDeviceId: PHONE }], listing: listed(), name: "USB ID" },
      { enrolled: [record(ADDRESS)], listing: listed(), name: "key off", networkDevices: false },
      { enrolled: [record(ADDRESS)], listing: listed(), name: "mismatch", reply: VERSION_REPLY_40 },
    ] as const;
    for (const { enrolled, listing, name, ...options } of cases) {
      const { handler, runner } = await networkHandler(listing, options);

      const present = await handler.listPresentPhysical(enrolled);

      expect(connects(runner), name).toEqual([]);
      if (name === "mismatch") {
        expect(present, name).toEqual([
          { driverDeviceId: ADDRESS, present: false, reason: "not-present" },
        ]);
      }
    }
  });
});

describe("Android physical handler under android.networkDevices: listAttachedPhysical", () => {
  it("lists host:port and mDNS network phones in any state beside the USB phones, once each, and never an emulator; key off lists USB only", async () => {
    const listing = devicesListing(
      USB_LINE,
      NETWORK_LINE,
      `${MDNS} offline transport_id:5`,
      "192.168.1.6:5555 unauthorized transport_id:6",
      `${ADDRESS} device product:o1s transport_id:7`,
      "emulator-5554 device product:sdk transport_id:8",
    );

    const on = await networkHandler(listing);
    await expect(on.handler.listAttachedPhysical()).resolves.toEqual(
      [PHONE, ADDRESS, MDNS, "192.168.1.6:5555"].sort(),
    );

    const off = await networkHandler(listing, { networkDevices: false });
    await expect(off.handler.listAttachedPhysical()).resolves.toEqual([PHONE]);
  });
});

describe("Android physical handler under android.networkDevices: reclaim", () => {
  const device = {
    address: ADDRESS,
    deviceId: ADDRESS,
    driverData: {},
    enrolledApps: ["com.example.kept"],
    hardwareSerial: "R58Y61A60HN",
    physical: true,
  } as const;
  const pmCommands = (runner: PhoneAdb) => runner.rests.filter((rest) => rest.includes("pm"));

  it("uninstalls only from the phone with the recorded hardware serial: another serial or an unreadable one throws before any pm command, and a USB record reads no serial", async () => {
    const same = await networkHandler(devicesListing(NETWORK_LINE));
    await expect(same.handler.reclaim(device)).resolves.toMatchObject({ state: "ready" });
    expect(same.runner.rests.findIndex((rest) => rest.includes("ro.serialno"))).toBe(0);
    expect(same.runner.installed).toEqual(["com.example.kept"]);

    const another = await networkHandler(devicesListing(NETWORK_LINE));
    another.runner.hardwareSerial = "ZZZ999";
    await expect(another.handler.reclaim(device)).rejects.toThrow(
      `the phone at ${ADDRESS} is not the enrolled one (hardware serial ZZZ999, enrolled R58Y61A60HN)`,
    );
    expect(pmCommands(another.runner)).toEqual([]);

    for (const failure of [FAILED, TIMED_OUT]) {
      const unreadable = await networkHandler(devicesListing(NETWORK_LINE));
      unreadable.runner.override((rest) => (rest.includes("ro.serialno") ? failure : undefined));
      await expect(unreadable.handler.reclaim(device)).rejects.toThrow(
        "physical reclaim could not read the hardware serial",
      );
      expect(pmCommands(unreadable.runner)).toEqual([]);
    }

    const usb = await networkHandler(devicesListing(USB_LINE));
    const { hardwareSerial: _none, ...usbRecord } = { ...device, address: PHONE, deviceId: PHONE };
    await expect(usb.handler.reclaim(usbRecord)).resolves.toMatchObject({ state: "ready" });
    expect(usb.runner.rests.flat()).not.toContain("ro.serialno");
  });
});

describe("Android driver under android.networkDevices: a leased network phone", () => {
  const leased = {
    address: ADDRESS,
    deviceId: ADDRESS,
    driverData: {},
    enrolledApps: [],
    hardwareSerial: "R58Y61A60HN",
    physical: true,
  } as const;

  it("is read from android.networkDevices by the driver, and hands its holder the address as the serial, scopes passthrough to it, still refuses transport subcommands and aims the screen at it", async () => {
    const off = await world();
    off.runner.devicesOutput = devicesListing(NETWORK_LINE);
    expect(await off.driver.inspectPhysical(ADDRESS)).toMatchObject({ reason: "network-only" });
    const { driver, runner } = await world({ config: { networkDevices: true } });
    runner.devicesOutput = devicesListing(NETWORK_LINE);
    expect(await driver.inspectPhysical(ADDRESS)).toMatchObject({
      driverDeviceId: ADDRESS,
      enrollable: true,
      hardwareSerial: "R58Y61A60HN",
    });

    expect(driver.leaseEnvironment(leased)).toEqual({
      ANDROID_ADB_SERVER_PORT: "5037",
      ANDROID_SERIAL: ADDRESS,
    });
    expect(await passthroughOf(driver, ["shell", "getprop"], leased)).toMatchObject({
      args: ["-P", "5037", "-s", ADDRESS, "shell", "getprop"],
    });
    for (const subcommand of ["connect", "disconnect", "pair", "tcpip", "usb"]) {
      const error = await rejectionOf(passthroughOf(driver, [subcommand, ADDRESS], leased));
      expect(error, subcommand).toBeInstanceOf(PassthroughRefusedError);
    }

    const { handler } = await networkHandler(devicesListing(NETWORK_LINE));
    expect(handler.screenTargetFor(leased, new FakeTcpStreamConnector()).serial).toBe(ADDRESS);
  });
});
