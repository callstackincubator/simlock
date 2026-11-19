import { readFileSync } from "node:fs";
import { expect, describe, it } from "vitest";
import type { PhysicalDriverDevice, PhysicalInspection, DeviceSpec } from "../../core/index.js";
import { FakeBytePipeLauncher } from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import {
  FAILURES,
  Fields,
  LIST_ARGV,
  LOCKED,
  Lab,
  OPEN_LOCK,
  PHONE,
  PHONE_ECID,
  PHONE_IDENTIFIER,
  PHONE_SERIAL,
  PHONE_UDID,
  PROPERTIES_GROUP,
  READ_LIMIT_MS,
  ReadScript,
  appsDocument,
  enrollableLab,
  expireAfter,
  inspect,
  listDocument,
  listed,
  lockArgv,
  lockDocument,
  waitForCalls,
  wire,
} from "./test-physical.js";

const listFixture = readFileSync(
  new URL("./fixtures/devicectl-list-devices.json", import.meta.url),
  "utf8",
);

const UNINSTALL_LIMIT_MS = 60_000;

const IPAD_WIFI_UDID = "00008112-000B3344556677AB";

const IPAD_WIRED_UDID = "00008027-00112233445566AA";

const enrolledWithGone = (): PhysicalDriverDevice => ({
  ...PHYSICAL_DEVICE,
  enrolledApps: ["com.example.kept", "com.example.gone"],
});

const PHYSICAL_DEVICE: PhysicalDriverDevice = {
  address: PHONE_UDID,
  deviceId: PHONE_UDID,
  driverData: {},
  enrolledApps: ["com.example.kept"],
  physical: true,
};

function fixtureDevices(): Fields[] {
  return (JSON.parse(listFixture) as { result: { devices: Fields[] } }).result.devices;
}

function fixtureDevice(udid: string): Fields {
  const found = fixtureDevices().find(
    (device) => (device["hardwareProperties"] as Fields)["udid"] === udid,
  );
  if (found === undefined) throw new Error(`fixture has no device ${udid}`);
  return found;
}

function withOsVersion(device: Fields, osVersionNumber: string): Fields {
  const copy = structuredClone(device) as {
    deviceProperties: Fields;
    properties: { software: Fields };
  } & Fields;
  copy.deviceProperties["osVersionNumber"] = osVersionNumber;
  copy.properties.software["osVersionNumber"] = osVersionNumber;
  return copy;
}

function appsArgv(udid: string): string[] {
  return [
    "xcrun",
    "devicectl",
    "device",
    "info",
    "apps",
    "--device",
    udid,
    "--json-output",
    "<json>",
  ];
}

function uninstallArgv(udid: string, bundle: string): string[] {
  return ["xcrun", "devicectl", "device", "uninstall", "app", "--device", udid, bundle];
}

interface Scenario {
  readonly change?: Fields;
  readonly id?: string;
  readonly lock?: string;
}

async function refusedAfterAccepting(
  scenario: Scenario,
): Promise<{ readonly inspection: PhysicalInspection; readonly calls: string[][] }> {
  const accepted = await inspect(enrollableLab(), PHONE_IDENTIFIER);
  expect(accepted).toMatchObject({ driverDeviceId: PHONE_UDID, enrollable: true });

  const lab = new Lab()
    .list([wire({ ...PHONE, ...scenario.change })])
    .lock(PHONE_UDID, { file: scenario.lock ?? OPEN_LOCK })
    .apps(PHONE_UDID, ["com.example.MyApp"]);
  const inspection = await inspect(lab, scenario.id ?? PHONE_IDENTIFIER);
  return { calls: lab.calls(), inspection };
}

describe("IosSimctlDriver physical handler: enrollment", () => {
  it.each([
    { id: PHONE_IDENTIFIER, label: "CoreDevice ID" },
    { id: String(PHONE_ECID), label: "ECID" },
    { id: PHONE_SERIAL, label: "serial number" },
  ])(
    "inspectPhysical with a $label returns the device's UDID, and every later call names the UDID",
    async ({ id }) => {
      const lab = enrollableLab();

      const result = await inspect(lab, id);

      expect(result).toMatchObject({ driverDeviceId: PHONE_UDID, enrollable: true });
      expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(PHONE_UDID), appsArgv(PHONE_UDID)]);
    },
  );

  it.each([
    { id: PHONE_UDID.toLowerCase(), label: "UDID in lower case" },
    { id: PHONE_IDENTIFIER.toLowerCase(), label: "CoreDevice ID in lower case" },
    { id: PHONE_SERIAL.toLowerCase(), label: "serial number in lower case" },
    { id: String(PHONE_ECID), label: "ECID in decimal" },
    {
      id: `0x${BigInt(PHONE_ECID).toString(16).toLowerCase()}`,
      label: "ECID as 0x hex in lower case",
    },
    {
      id: `0x${BigInt(PHONE_ECID).toString(16).toUpperCase()}`,
      label: "ECID as 0x hex in upper case",
    },
  ])("inspectPhysical matches a $label", async ({ id }) => {
    const result = await inspect(enrollableLab(), id);

    expect(result).toMatchObject({ driverDeviceId: PHONE_UDID, enrollable: true });
  });

  it("inspectPhysical matches an ECID above 2^53 by its exact digits, and not an ECID one apart", async () => {
    const big = [wire({ ...PHONE, ecid: "@ecid:9007199254740993" })];

    const decimal = await inspect(enrollableLab(big), "9007199254740993");
    const hex = await inspect(enrollableLab(big), "0x20000000000001");
    const oneApart = await inspect(enrollableLab(big), "9007199254740992");

    expect(decimal).toMatchObject({ driverDeviceId: PHONE_UDID, enrollable: true });
    expect(hex).toMatchObject({ driverDeviceId: PHONE_UDID, enrollable: true });
    expect(oneApart).toMatchObject({ enrollable: false, reason: "not-connected" });
  });

  it("inspectPhysical with a device's name matches nothing and is refused as not connected", async () => {
    const accepted = await inspect(enrollableLab(), PHONE_UDID);
    expect(accepted).toMatchObject({ enrollable: true });

    const byName = await inspect(new Lab().list([wire(PHONE)]), "Szymon's iPhone");
    const byDnsName = await inspect(
      new Lab().list([wire(PHONE)]),
      "Szymons-iPhone.coredevice.local",
    );

    expect(byName).toMatchObject({ enrollable: false, reason: "not-connected" });
    expect(byDnsName).toMatchObject({ enrollable: false, reason: "not-connected" });
  });

  it("inspectPhysical of an ID listed once over localNetwork and once wired reads the wired entry and enrolls it", async () => {
    const wifi = wire({
      ...PHONE,
      identifier: "WIFI-ENTRY",
      osVersionNumber: "17.0",
      transportType: "localNetwork",
    });
    const lab = enrollableLab([wifi, wire(PHONE)]);

    const result = await inspect(lab, PHONE_UDID);

    expect(result).toMatchObject({
      driverDeviceId: PHONE_UDID,
      enrollable: true,
      osVersion: "18.4",
    });
    expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(PHONE_UDID), appsArgv(PHONE_UDID)]);
  });

  it('inspectPhysical of an ID that matches two wired entries is refused unreadable with "matches more than one device", and runs no lock read', async () => {
    const single = await inspect(enrollableLab([wire(PHONE)]), PHONE_UDID);
    expect(single).toMatchObject({ enrollable: true });
    const lab = enrollableLab([wire(PHONE), wire({ ...PHONE, identifier: "SECOND-WIRED" })]);

    const result = await inspect(lab, PHONE_UDID);

    expect(result).toMatchObject({
      enrollable: false,
      message: expect.stringContaining("matches more than one device"),
      reason: "unreadable",
    });
    expect(lab.calls()).toEqual([LIST_ARGV]);
  });

  it("inspectPhysical of an ID that matches two entries, neither wired, answers the refusal of the first one in the list (a Wi-Fi entry before a sameMachine one gives network-only)", async () => {
    const wifi = wire({ ...PHONE, identifier: "WIFI", transportType: "localNetwork" });
    const sameMachine = wire({ ...PHONE, identifier: "LOCAL", transportType: "sameMachine" });
    const withWired = await inspect(enrollableLab([wifi, sameMachine, wire(PHONE)]), PHONE_UDID);
    expect(withWired).toMatchObject({ enrollable: true });

    const wifiFirst = await inspect(new Lab().list([wifi, sameMachine]), PHONE_UDID);
    const sameMachineFirst = await inspect(new Lab().list([sameMachine, wifi]), PHONE_UDID);

    expect(wifiFirst).toMatchObject({ enrollable: false, reason: "network-only" });
    expect(sameMachineFirst).toMatchObject({ enrollable: false, reason: "virtual-device" });
  });

  it("inspectPhysical returns marketingName as model, osVersionNumber as OS version, tablet for an iPad and phone for an iPhone", async () => {
    const phone = await inspect(
      new Lab().list(listFixture).lock(PHONE_UDID).apps(PHONE_UDID, ["com.example.MyApp"]),
      PHONE_UDID,
    );
    const ipad = await inspect(
      new Lab().list(listFixture).lock(IPAD_WIRED_UDID).apps(IPAD_WIRED_UDID, []),
      IPAD_WIRED_UDID,
    );

    expect(phone).toMatchObject({
      class: "phone",
      enrollable: true,
      model: "iPhone 15 Pro",
      osVersion: "18.4",
    });
    expect(ipad).toMatchObject({
      class: "tablet",
      driverDeviceId: IPAD_WIRED_UDID,
      enrollable: true,
      model: "iPad Pro 11-inch (M4)",
      osVersion: "18.2",
    });
  });

  it("inspectPhysical falls back to productType when marketingName is absent", async () => {
    const withName = await inspect(enrollableLab(), PHONE_UDID);
    expect(withName).toMatchObject({ enrollable: true, model: "iPhone 15 Pro" });

    const result = await inspect(
      enrollableLab([wire({ ...PHONE, marketingName: undefined })]),
      PHONE_UDID,
    );

    expect(result).toMatchObject({ enrollable: true, model: "iPhone16,1" });
  });

  it("inspectPhysical returns the bundle IDs device info apps lists, and the apps read passes no --include-* flag", async () => {
    const lab = enrollableLab([wire(PHONE)], PHONE_UDID, [
      "com.example.MyApp",
      "com.example.Notes",
    ]);

    const result = await inspect(lab, PHONE_UDID);

    expect(result).toMatchObject({
      apps: ["com.example.MyApp", "com.example.Notes"],
      enrollable: true,
    });
    const appsCall = lab.calls().find((argv) => argv.includes("apps"));
    expect(appsCall).toEqual(appsArgv(PHONE_UDID));
    expect(appsCall?.some((argument) => argument.startsWith("--include"))).toBe(false);
  });

  it.each([
    {
      change: {},
      id: "00008110-FFFFFFFFFFFF",
      label: "a device that is not connected",
      reason: "not-connected",
    },
    { change: { reality: "simulated" }, label: "a simulated device", reason: "virtual-device" },
    {
      change: { transportType: "sameMachine" },
      label: "a sameMachine device",
      reason: "virtual-device",
    },
    {
      change: { transportType: "localNetwork" },
      label: "a Wi-Fi only device",
      reason: "network-only",
    },
    {
      change: { deviceType: "appleTV", platform: "tvOS" },
      label: "a tvOS device",
      reason: "unsupported-kind",
    },
    {
      change: { deviceType: "appleWatch", platform: "watchOS" },
      label: "a watchOS device",
      reason: "unsupported-kind",
    },
    {
      change: { deviceType: "appleVision", platform: "visionOS" },
      label: "a visionOS device",
      reason: "unsupported-kind",
    },
    {
      change: { deviceType: "mac", platform: "macOS" },
      label: "a macOS device",
      reason: "unsupported-kind",
    },
    { change: { osVersionNumber: "16.7.8" }, label: "a device below iOS 17", reason: "os-too-old" },
    {
      change: { isMobileDeviceOnly: true },
      label: "an isMobileDeviceOnly device",
      reason: "os-too-old",
    },
    {
      change: { pairingState: "unpaired" },
      label: "a device that is not paired",
      reason: "untrusted",
    },
    {
      change: { developerModeStatus: "disabled" },
      label: "a device with Developer Mode off",
      reason: "developer-mode-off",
    },
  ] as { change: Fields; id?: string; label: string; reason: string }[])(
    "inspectPhysical refuses $label with $reason",
    async ({ change, id, reason }) => {
      const { inspection } = await refusedAfterAccepting({
        change,
        ...(id === undefined ? {} : { id }),
      });

      expect(inspection).toMatchObject({ enrollable: false, reason });
    },
  );

  it('inspectPhysical refuses a locked device with locked and "locked: unlock it and try again"', async () => {
    const { inspection } = await refusedAfterAccepting({ lock: LOCKED });

    expect(inspection).toMatchObject({
      enrollable: false,
      message: expect.stringContaining("locked: unlock it and try again"),
      reason: "locked",
    });
  });

  it.each([
    {
      change: { reality: "simulated", transportType: "localNetwork" },
      label: "a simulated entry over localNetwork is virtual-device",
      reason: "virtual-device",
    },
    {
      change: { deviceType: "appleTV", platform: "tvOS", transportType: "localNetwork" },
      label: "an Apple TV over Wi-Fi is network-only",
      reason: "network-only",
    },
    {
      change: { deviceType: "appleTV", osVersionNumber: "16.1", platform: "tvOS" },
      label: "a wired Apple TV on tvOS 16 is unsupported-kind",
      reason: "unsupported-kind",
    },
    {
      change: { osVersionNumber: "16.4", pairingState: "unpaired" },
      label: "a wired, unpaired iPhone on iOS 16 is os-too-old",
      reason: "os-too-old",
    },
    {
      change: { developerModeStatus: "disabled", pairingState: "unpaired" },
      label: "a wired, unpaired iPhone with Developer Mode off is untrusted",
      reason: "untrusted",
    },
    {
      change: { developerModeStatus: "disabled" },
      label: "a wired iPhone with Developer Mode off that is locked is developer-mode-off",
      lock: LOCKED,
      reason: "developer-mode-off",
    },
  ] as { change: Fields; label: string; lock?: string; reason: string }[])(
    "the first check in the order wins: $label",
    async ({ change, lock, reason }) => {
      const { inspection } = await refusedAfterAccepting({
        change,
        ...(lock === undefined ? {} : { lock }),
      });

      expect(inspection).toMatchObject({ enrollable: false, reason });
    },
  );

  it("inspectPhysical runs no lock read when an earlier check refuses", async () => {
    const earlier: Fields[] = [
      { pairingState: "unpaired" },
      { developerModeStatus: "disabled" },
      { osVersionNumber: "16.4" },
      { transportType: "localNetwork" },
    ];

    for (const change of earlier) {
      const { calls, inspection } = await refusedAfterAccepting({ change });

      expect(inspection).toMatchObject({ enrollable: false });
      expect(calls).toEqual([LIST_ARGV]);
    }
  });

  it("inspectPhysical of the fixture's Wi-Fi iPad, which has no reality and no developerModeStatus, is refused network-only, not unreadable; an iPad over Wi-Fi on iOS 16 is network-only too", async () => {
    const accepted = await inspect(
      new Lab().list(listFixture).lock(IPAD_WIRED_UDID).apps(IPAD_WIRED_UDID, []),
      IPAD_WIRED_UDID,
    );
    expect(accepted).toMatchObject({ enrollable: true });
    const wifiIpad = fixtureDevice(IPAD_WIFI_UDID);
    expect(wifiIpad).not.toHaveProperty("hardwareProperties.reality");

    const fixture = await inspect(new Lab().list(listFixture), IPAD_WIFI_UDID);
    const old = await inspect(new Lab().list([withOsVersion(wifiIpad, "16.7")]), IPAD_WIFI_UDID);

    expect(fixture).toMatchObject({ enrollable: false, reason: "network-only" });
    expect(old).toMatchObject({ enrollable: false, reason: "network-only" });
  });

  it.each([
    { change: { platform: undefined }, label: "no platform" },
    { change: { pairingState: undefined }, label: "no pairingState" },
  ] as { change: Fields; label: string }[])(
    "inspectPhysical of an entry over Wi-Fi with $label is refused network-only: no field is required before the wired step",
    async ({ change }) => {
      const { inspection } = await refusedAfterAccepting({
        change: { ...change, transportType: "localNetwork" },
      });

      expect(inspection).toMatchObject({ enrollable: false, reason: "network-only" });
    },
  );

  it("inspectPhysical of a physical entry with no transportType is refused unreadable", async () => {
    const { inspection } = await refusedAfterAccepting({
      change: { reality: "physical", transportType: undefined },
    });

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it.each([
    "udid",
    "platform",
    "deviceType",
    "osVersionNumber",
    "pairingState",
    "developerModeStatus",
  ])("inspectPhysical of a wired entry that lacks %s is refused unreadable", async (field) => {
    const { inspection } = await refusedAfterAccepting({ change: { [field]: undefined } });

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it("inspectPhysical of a wired entry whose lock read lacks a boolean passcodeRequired is refused unreadable", async () => {
    const { inspection } = await refusedAfterAccepting({
      lock: lockDocument({ unlockedSinceBoot: true }),
    });

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it("inspectPhysical of an entry with no isMobileDeviceOnly reads it as false", async () => {
    const withFlag = await inspect(enrollableLab(), PHONE_UDID);
    expect(withFlag).toMatchObject({ enrollable: true });

    const result = await inspect(
      enrollableLab([wire({ ...PHONE, isMobileDeviceOnly: undefined })]),
      PHONE_UDID,
    );

    expect(result).toMatchObject({ enrollable: true });
  });

  it.each([
    { title: "has no result.devices list", document: JSON.stringify({ result: {} }) },
    {
      title: "holds a device entry that is not an object",
      document: JSON.stringify({ result: { devices: [wire(PHONE), "not-an-object"] } }),
    },
  ])(
    "inspectPhysical whose list devices read $title is refused unreadable naming list devices",
    async ({ document }) => {
      const result = await inspect(new Lab().list(document), PHONE_UDID);

      expect(result).toMatchObject({
        enrollable: false,
        message: expect.stringContaining("list devices"),
        reason: "unreadable",
      });
    },
  );

  it.each([
    { title: "has no result.apps list", document: JSON.stringify({ result: {} }) },
    {
      title: "lists an app with no bundleIdentifier",
      document: JSON.stringify({ result: { apps: [{ name: "Anonymous" }] } }),
    },
  ])(
    "inspectPhysical whose apps read $title is refused unreadable naming the apps read, with no app list",
    async ({ document }) => {
      const lab = new Lab()
        .list([wire(PHONE)])
        .lock(PHONE_UDID)
        .apps(PHONE_UDID, { file: document });

      const result = await inspect(lab, PHONE_UDID);

      expect(result).toMatchObject({
        enrollable: false,
        message: expect.stringContaining("apps"),
        reason: "unreadable",
      });
      expect(result).not.toHaveProperty("apps");
    },
  );

  it.each([
    { change: { isMobileDeviceOnly: "yes" }, title: "a non-boolean isMobileDeviceOnly" },
    { change: { osVersionNumber: "beta" }, title: "an OS version with no numeric major" },
    {
      change: { marketingName: undefined, productType: undefined },
      title: "neither marketingName nor productType",
    },
  ])("inspectPhysical of a wired entry with $title is refused unreadable", async ({ change }) => {
    const { inspection } = await refusedAfterAccepting({ change });

    expect(inspection).toMatchObject({ enrollable: false, reason: "unreadable" });
  });

  it.each(
    [
      { name: "list devices", position: 1 },
      { name: "lockState", position: 2 },
      { name: "apps", position: 3 },
    ].flatMap((read) =>
      FAILURES.map((failure) => ({ ...read, failure, failureTitle: failure.title })),
    ),
  )(
    "inspectPhysical whose $name read $failureTitle is refused unreadable with a message naming that read, returns no app list, and does not reject",
    async ({ failure, name, position }) => {
      const lab = new Lab();
      const failing = (file: string): ReadScript => failure.script(file);
      if (name === "list devices") lab.list([wire(PHONE)], failing(listDocument([wire(PHONE)])));
      else lab.list([wire(PHONE)]);
      lab.lock(PHONE_UDID, name === "lockState" ? failing(OPEN_LOCK) : { file: OPEN_LOCK });
      lab.apps(
        PHONE_UDID,
        name === "apps" ? failing(appsDocument(["com.example.MyApp"])) : ["com.example.MyApp"],
      );
      const driver = await lab.driver();

      const result = await expireAfter(
        lab,
        driver.inspectPhysical(PHONE_UDID),
        failure.expires ? position : 0,
        failure.expires ? READ_LIMIT_MS : 0,
      );

      expect(result).toMatchObject({
        enrollable: false,
        message: expect.stringContaining(name),
        reason: "unreadable",
      });
      expect(result).not.toHaveProperty("apps");
      expect(lab.timeouts()[position - 1]).toBe(READ_LIMIT_MS);
    },
  );

  it.each([
    {
      change: {},
      field: "udid",
      id: PHONE_IDENTIFIER,
      expected: { driverDeviceId: PHONE_UDID, enrollable: true },
    },
    {
      change: { reality: "simulated" },
      field: "reality",
      expected: { enrollable: false, reason: "virtual-device" },
    },
    {
      change: { platform: "tvOS" },
      contradiction: "iOS",
      field: "platform",
      expected: { enrollable: false, reason: "unsupported-kind" },
    },
    {
      change: { deviceType: "appleTV" },
      contradiction: "iPhone",
      field: "deviceType",
      expected: { enrollable: false, reason: "unsupported-kind" },
    },
    { change: {}, field: "marketingName", expected: { enrollable: true, model: "iPhone 15 Pro" } },
    {
      change: { marketingName: undefined },
      field: "productType",
      expected: { enrollable: true, model: "iPhone16,1" },
    },
    {
      change: {},
      field: "ecid",
      id: String(PHONE_ECID),
      expected: { driverDeviceId: PHONE_UDID, enrollable: true },
    },
    {
      change: {},
      field: "serialNumber",
      id: PHONE_SERIAL,
      expected: { driverDeviceId: PHONE_UDID, enrollable: true },
    },
    {
      change: { osVersionNumber: "16.7" },
      contradiction: "18.4",
      field: "osVersionNumber",
      expected: { enrollable: false, reason: "os-too-old" },
    },
    {
      change: { developerModeStatus: "disabled" },
      contradiction: "enabled",
      field: "developerModeStatus",
      expected: { enrollable: false, reason: "developer-mode-off" },
    },
    {
      change: { transportType: "localNetwork" },
      contradiction: "wired",
      field: "transportType",
      expected: { enrollable: false, reason: "network-only" },
    },
    {
      change: { pairingState: "unpaired" },
      contradiction: "paired",
      field: "pairingState",
      expected: { enrollable: false, reason: "untrusted" },
    },
  ] as {
    change: Fields;
    contradiction?: string;
    expected: Record<string, unknown>;
    field: string;
    id?: string;
  }[])(
    "the parser reads $field from the deprecated key and from properties alone",
    async ({ change, contradiction, expected, field, id }) => {
      const device = { ...PHONE, ...change };
      const contradicted = wire(device);
      const group = PROPERTIES_GROUP[field] ?? "";
      const properties = contradicted["properties"] as Record<string, Fields>;
      // why: a parser that reads `properties` first must see a different value than the deprecated key holds, and for a refusing row one that enrolls.
      Object.assign(properties[group] ?? {}, {
        [field]: contradiction ?? "contradicts-the-deprecated-key",
      });
      const fromDeprecated = await inspect(enrollableLab([contradicted]), id ?? PHONE_IDENTIFIER);
      const fromProperties = await inspect(
        enrollableLab([wire(device, [field])]),
        id ?? PHONE_IDENTIFIER,
      );

      expect(fromDeprecated).toMatchObject(expected);
      expect(fromProperties).toEqual(fromDeprecated);
    },
  );
});

describe("IosSimctlDriver physical handler: stream iOS version", () => {
  const streamSettings = { bitrateKbps: 1_500, fps: 30, maxDimension: 720 };
  const DEVICE_PROGRAM = "/dist/bin/simlock-device-capture";

  async function streamDriver(lab: Lab, launcher: FakeBytePipeLauncher): Promise<IosSimctlDriver> {
    await lab.filesystem.mkdirp("/dist/bin");
    await lab.filesystem.writeFileAtomic(DEVICE_PROGRAM, "");
    return lab.driver(undefined, {
      baseEnvironment: {},
      command: "/dist/bin/simlock-screen-capture",
      deviceCommand: DEVICE_PROGRAM,
      launcher,
    });
  }

  async function openStream(driver: IosSimctlDriver): Promise<unknown> {
    const capture = driver.screenCapture;
    if (capture === undefined) throw new Error("the driver offers no screen capture");
    return capture.open(PHYSICAL_DEVICE, streamSettings, new AbortController().signal);
  }

  it("a listed iPhone's osVersionNumber decides the stream: iOS 18.4 is refused naming it, and nothing starts", async () => {
    const lab = new Lab().list([listed(PHONE_UDID)]);
    const launcher = new FakeBytePipeLauncher();
    const driver = await streamDriver(lab, launcher);

    await expect(openStream(driver)).rejects.toThrow(`${PHONE_UDID} runs iOS 18.4`);
    expect(lab.calls()).toEqual([LIST_ARGV]);
    expect(launcher.starts).toEqual([]);
  });

  it("an iPhone devicectl does not list starts the device program, the program's own error deciding", async () => {
    const lab = new Lab().list([]);
    const launcher = new FakeBytePipeLauncher();
    const driver = await streamDriver(lab, launcher);

    await openStream(driver);
    expect(launcher.starts.map((start) => start.command)).toEqual([DEVICE_PROGRAM]);
  });
});

describe("IosSimctlDriver physical handler: reclaim", () => {
  it("reclaim of a physical device uninstalls each listed bundle ID missing from enrolledApps, with --device <UDID>, and returns strategy uninstall", async () => {
    const lab = new Lab()
      .apps(PHONE_UDID, ["com.example.kept", "com.example.a", "com.example.b"])
      .uninstall(PHONE_UDID, "com.example.a")
      .uninstall(PHONE_UDID, "com.example.b");

    const result = await (await lab.driver()).reclaim(PHYSICAL_DEVICE, { clean: "standard" });

    expect(lab.calls()).toEqual([
      appsArgv(PHONE_UDID),
      uninstallArgv(PHONE_UDID, "com.example.a"),
      uninstallArgv(PHONE_UDID, "com.example.b"),
    ]);
    expect(result).toMatchObject({ strategy: "uninstall" });
  });

  it("reclaim uninstalls nothing on the enrollment list, and nothing the apps read did not list", async () => {
    const lab = new Lab()
      .apps(PHONE_UDID, ["com.example.kept", "com.example.a"])
      .uninstall(PHONE_UDID, "com.example.a");

    await (await lab.driver()).reclaim(enrolledWithGone(), { clean: "full" });

    expect(lab.calls()).toEqual([appsArgv(PHONE_UDID), uninstallArgv(PHONE_UDID, "com.example.a")]);
  });

  it("reclaim reports enrolled bundle IDs the read no longer lists as missingApps, and installs nothing", async () => {
    const lab = new Lab()
      .apps(PHONE_UDID, ["com.example.kept", "com.example.a"])
      .uninstall(PHONE_UDID, "com.example.a");

    const result = await (await lab.driver()).reclaim(enrolledWithGone(), { clean: "standard" });

    expect(result).toMatchObject({ missingApps: ["com.example.gone"], strategy: "uninstall" });
    expect(lab.calls().some((argv) => argv.includes("install"))).toBe(false);
  });

  it("reclaim whose apps read fails rejects and uninstalls nothing", async () => {
    const lab = new Lab()
      .apps(PHONE_UDID, { exit: 1, file: appsDocument(["com.example.a"]) })
      .uninstall(PHONE_UDID, "com.example.a");
    const driver = await lab.driver();

    await expect(driver.reclaim(PHYSICAL_DEVICE, { clean: "standard" })).rejects.toBeInstanceOf(
      Error,
    );

    expect(lab.calls()).toEqual([appsArgv(PHONE_UDID)]);
  });

  it.each([
    { expires: false, script: { exit: 1 } as ReadScript, title: "exits non-zero" },
    { expires: true, script: { hangs: true } as ReadScript, title: "passes 60 s" },
  ])(
    "reclaim whose uninstall $title rejects and runs no further uninstall",
    async ({ expires, script }) => {
      const lab = new Lab()
        .apps(PHONE_UDID, ["com.example.a", "com.example.b"])
        .uninstall(PHONE_UDID, "com.example.a", script)
        .uninstall(PHONE_UDID, "com.example.b");
      const driver = await lab.driver();
      const pending = driver.reclaim(PHYSICAL_DEVICE, { clean: "standard" });
      void pending.catch(() => undefined);

      if (expires) {
        await waitForCalls(lab.runner, 2);
        lab.clock.advance(UNINSTALL_LIMIT_MS);
      }

      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(lab.calls()).toEqual([
        appsArgv(PHONE_UDID),
        uninstallArgv(PHONE_UDID, "com.example.a"),
      ]);
      expect(lab.timeouts()).toEqual([READ_LIMIT_MS, UNINSTALL_LIMIT_MS]);
    },
  );

  it("estimate of a physical reclaim is 90 000 ms at both clean levels; a virtual reclaim's estimate is unchanged", async () => {
    const driver = await new Lab().driver();
    const physical: DeviceSpec = {
      class: "phone",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      physical: true,
      platform: "ios",
    };
    const virtual: DeviceSpec = {
      model: "iPhone 16",
      osVersion: "26.5",
      physical: false,
      platform: "ios",
    };

    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, physical)).toBe(90_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, physical)).toBe(90_000);
    expect(driver.estimate({ clean: "standard", operation: "reclaim" }, virtual)).toBe(34_000);
    expect(driver.estimate({ clean: "full", operation: "reclaim" }, virtual)).toBe(34_000);
  });
});
