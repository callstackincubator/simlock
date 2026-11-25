import { describe, expect, it } from "vitest";
import { FakeTcpProbe, ProcessSpawnError } from "../../ports/index.js";
import { AndroidPhysicalHandler } from "./physical-handler.js";
import {
  sdk,
  adb,
  PHONE,
  VERSION_REPLY_41,
  VERSION_REPLY_40,
  USB_LINE,
  FAILED,
  TIMED_OUT,
  PhoneAdb,
  world,
  androidFilesystem,
  devicesListing,
  isDevicesListing,
  isGetprop,
  isUserRead,
  isPackageList,
} from "./test-physical-handler.js";

// why: the physical handler is a part of a decomposed module, so its tests reach it directly.
describe("Android physical handler: inspectPhysical", () => {
  it("returns the serial, ro.product.model, the API level, class phone and the packages pm list packages -3 --user <id> lists for the id am get-current-user prints", async () => {
    const { driver, runner } = await world();
    runner.userOutput = "10\n";
    runner.installed.splice(0, runner.installed.length, "com.example.kept", "com.example.stray");

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toEqual({
      apps: ["com.example.kept", "com.example.stray"],
      class: "phone",
      driverDeviceId: PHONE,
      enrollable: true,
      model: "SM-G991B",
      osVersion: "34",
    });
    expect(runner.rests).toContainEqual([
      "-s",
      PHONE,
      "shell",
      "pm",
      "list",
      "packages",
      "-3",
      "--user",
      "10",
    ]);
    expect(runner.rests).toContainEqual(["-s", PHONE, "shell", "getprop", "ro.product.model"]);
  });

  it("refuses a serial in state unauthorized as untrusted, and runs no command naming it", async () => {
    const { driver, runner } = await world();
    expect(await driver.inspectPhysical(PHONE)).toMatchObject({ enrollable: true });
    runner.calls.length = 0;
    runner.devicesOutput = devicesListing(`${PHONE} unauthorized usb:1-1 transport_id:3`);

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "untrusted" });
    expect(runner.commands.filter((call) => call.args.includes("-s"))).toEqual([]);
  });

  const networkOnlyRows: (readonly [string, string, string])[] = [
    [
      "a network serial",
      "192.168.1.5:5555 device product:o1s model:SM_G991B transport_id:4",
      "192.168.1.5:5555",
    ],
    [
      "an mDNS name",
      "adb-R58M123ABC-xyz._adb-tls-connect._tcp device product:o1s model:SM_G991B transport_id:4",
      "adb-R58M123ABC-xyz._adb-tls-connect._tcp",
    ],
    [
      "a listed emulator",
      "emulator-5554 device product:sdk_gphone model:sdk transport_id:1",
      "emulator-5554",
    ],
    [
      "a USB-shaped serial on a network line",
      `${PHONE} device product:o1s model:SM_G991B transport_id:3`,
      PHONE,
    ],
  ];

  // why: adb on Windows lists no `usb:` path for any USB device, so there a USB-shaped serial
  // without one is a phone to enrol (`physical-handler-windows.test.ts`), not a network line.
  it.each(
    networkOnlyRows.filter(
      ([name]) => process.platform !== "win32" || name !== "a USB-shaped serial on a network line",
    ),
  )(
    "refuses %s as network-only with the USB-only message, and runs no command naming it",
    async (_name, line, id) => {
      const { driver, runner } = await world();
      runner.devicesOutput = devicesListing(line);

      const inspection = await driver.inspectPhysical(id);

      expect(inspection).toMatchObject({ enrollable: false, reason: "network-only" });
      expect((inspection as { message: string }).message).toContain(
        "only USB-connected devices can be enrolled",
      );
      expect(runner.commands.filter((call) => call.args.includes("-s"))).toEqual([]);
    },
  );

  it("inspects a host:port-shaped serial on a USB transport: the transport decides, not the shape", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(
      "192.168.1.5:5555 device usb:1-1 product:o1s model:SM_G991B transport_id:5",
    );

    const inspection = await driver.inspectPhysical("192.168.1.5:5555");

    expect(inspection).toMatchObject({ driverDeviceId: "192.168.1.5:5555", enrollable: true });
  });

  it.each([
    ["not listed", devicesListing()],
    ["listed offline", devicesListing(`${PHONE} offline usb:1-1 transport_id:3`)],
  ])("refuses a serial that is %s as not-connected", async (_name, listing) => {
    const { driver, runner } = await world();
    expect(await driver.inspectPhysical(PHONE)).toMatchObject({ enrollable: true });
    runner.devicesOutput = listing;

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "not-connected" });
  });

  it.each([
    [
      "adb devices -l fails",
      (rest: readonly string[]) => (isDevicesListing(rest) ? FAILED : undefined),
      /could not read the device list \(adb devices -l\)/,
    ],
    [
      "adb devices -l passes 30 s",
      (rest: readonly string[]) => (isDevicesListing(rest) ? TIMED_OUT : undefined),
      /could not read the device list \(adb devices -l\)/,
    ],
    [
      "getprop fails",
      (rest: readonly string[]) => (isGetprop(rest) ? FAILED : undefined),
      /could not read the model/,
    ],
    [
      "the user id read fails",
      (rest: readonly string[]) => (isUserRead(rest) ? FAILED : undefined),
      /could not read the current user id/,
    ],
    [
      "the package list fails",
      (rest: readonly string[]) => (isPackageList(rest) ? FAILED : undefined),
      /could not read the user apps/,
    ],
  ])(
    "is refused unreadable naming the read, and does not reject, when %s",
    async (_name, override, named) => {
      const { driver, runner } = await world();
      runner.override(override);

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect((inspection as { message: string }).message).toMatch(named);
    },
  );

  it("is refused unreadable, and does not reject, when the process runner cannot spawn adb", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => {
      if (isDevicesListing(rest)) throw new ProcessSpawnError(adb, rest);
      return undefined;
    });

    const inspection = await driver.inspectPhysical(PHONE);

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it("lists nothing present, and does not reject, when the process runner cannot spawn adb", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => {
      if (isDevicesListing(rest)) throw new ProcessSpawnError(adb, rest);
      return undefined;
    });

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });

  it.each([
    ["a shell injection", "0; rm -r /sdcard\n"],
    ["nothing", ""],
    ["seven digits", "1234567\n"],
  ])(
    "is refused unreadable and runs no pm list packages when am get-current-user prints %s",
    async (_name, printed) => {
      const { driver, runner } = await world();
      runner.userOutput = printed;

      const inspection = await driver.inspectPhysical(PHONE);

      expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
      expect(runner.rests.some(isPackageList)).toBe(false);
    },
  );
});

describe("Android physical handler: listPresentPhysical", () => {
  it("answers a USB serial in state device present with its API level, an unauthorized one not present untrusted, and an offline, network-only or missing one not present not-present", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(
      USB_LINE,
      "UNAUTH1 unauthorized usb:1-2 transport_id:4",
      "OFFLINE1 offline usb:1-3 transport_id:5",
      "192.168.1.5:5555 device product:o1s transport_id:6",
    );

    const present = await driver.listPresentPhysical([
      { driverDeviceId: PHONE },
      { driverDeviceId: "UNAUTH1" },
      { driverDeviceId: "OFFLINE1" },
      { driverDeviceId: "192.168.1.5:5555" },
      { driverDeviceId: "MISSING1" },
    ]);

    expect(present).toEqual([
      { driverDeviceId: PHONE, osVersion: "34", present: true },
      { driverDeviceId: "UNAUTH1", present: false, reason: "untrusted" },
      { driverDeviceId: "OFFLINE1", present: false, reason: "not-present" },
      { driverDeviceId: "192.168.1.5:5555", present: false, reason: "not-present" },
      { driverDeviceId: "MISSING1", present: false, reason: "not-present" },
    ]);
  });

  it("gives no entry, and runs no command, for a USB phone that is not among the given serials", async () => {
    const { driver, runner } = await world();
    runner.devicesOutput = devicesListing(USB_LINE, "OTHER99 device usb:1-2 transport_id:4");

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, osVersion: "34", present: true }]);
    expect(runner.rests.flat()).not.toContain("OTHER99");
  });

  it.each([
    ["fails", FAILED],
    ["has no exit code", TIMED_OUT],
  ])(
    "answers every given serial not present not-present, and does not reject, when adb devices -l %s",
    async (_name, result) => {
      const { driver, runner } = await world();
      runner.override((rest) => (isDevicesListing(rest) ? result : undefined));

      const present = await driver.listPresentPhysical([
        { driverDeviceId: PHONE },
        { driverDeviceId: "SERIAL2" },
      ]);

      expect(present).toEqual([
        { driverDeviceId: PHONE, present: false, reason: "not-present" },
        { driverDeviceId: "SERIAL2", present: false, reason: "not-present" },
      ]);
    },
  );

  it("answers a present serial whose getprop fails not present not-present", async () => {
    const { driver, runner } = await world();
    runner.override((rest) => (isGetprop(rest) ? FAILED : undefined));

    const present = await driver.listPresentPhysical([{ driverDeviceId: PHONE }]);

    expect(present).toEqual([{ driverDeviceId: PHONE, present: false, reason: "not-present" }]);
  });
});

describe("Android physical handler: listAttachedPhysical", () => {
  // why: the Windows rule needs `platform: "win32"`, which the driver surface cannot fake per host;
  // the handler is built straight, as the Windows describe below does.
  async function handlerFor(
    listing: string,
    options: { readonly platform?: NodeJS.Platform; readonly reply?: string } = {},
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
      platform: options.platform ?? "linux",
      processRunner: runner,
      tcpProbe: probe,
    });
    return { handler, runner };
  }

  it("lists the phones on USB in any state, none on the network or an emulator, throws when the list cannot be read, and runs no adb command at a protocol mismatch", async () => {
    const listings = [
      {
        listing: devicesListing(
          USB_LINE,
          "UNAUTH1 unauthorized usb:1-2 transport_id:4",
          "OFFLINE1 offline usb:1-3 transport_id:5",
          "192.168.1.5:5555 device product:o1s transport_id:6",
          "emulator-5554 device product:sdk transport_id:7",
        ),
        listed: [PHONE, "UNAUTH1", "OFFLINE1"],
        name: "linux",
        platform: "linux",
      },
      {
        listing: devicesListing(
          `${PHONE} device product:a70qxtc transport_id:1`,
          "192.168.1.5:5555 device product:o1s transport_id:6",
        ),
        listed: [PHONE],
        name: "windows, with no usb: path and the header line",
        platform: "win32",
      },
    ] as const;
    for (const { listing, listed, name, platform } of listings) {
      const { handler, runner } = await handlerFor(listing, { platform });

      await expect(handler.listAttachedPhysical(), name).resolves.toEqual([...listed].sort());
      expect(runner.rests, name).toEqual([["devices", "-l"]]);
    }

    const failing = await handlerFor(devicesListing(USB_LINE));
    failing.runner.override((rest) => (isDevicesListing(rest) ? FAILED : undefined));
    await expect(failing.handler.listAttachedPhysical()).rejects.toThrow(
      /could not read the device list \(adb devices -l\)/,
    );

    const mismatch = await handlerFor(devicesListing(USB_LINE), { reply: VERSION_REPLY_40 });
    await expect(mismatch.handler.listAttachedPhysical()).rejects.toThrow(/speaks protocol 40/);
    expect(mismatch.runner.commands).toEqual([]);
  });
});
