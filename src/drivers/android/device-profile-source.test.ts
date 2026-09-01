import { describe, expect, it } from "vitest";

import { MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import {
  BuiltinDeviceProfileSource,
  DeviceProfileRegistry,
  parseDevicesXml,
  UserDeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";

const avdmanager = "/android-sdk/cmdline-tools/latest/bin/avdmanager";
const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;
const devicesXmlPath = "/home/simlock/.android/devices.xml";

describe("BuiltinDeviceProfileSource", () => {
  it("resolves by name or id, case-insensitively", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(pixelDevices),
      processResult(pixelDevices),
      processResult(pixelDevices),
    ]);
    const source = new BuiltinDeviceProfileSource(avdmanager, runner);

    await expect(source.resolve("Pixel 8")).resolves.toEqual({
      avdmanagerId: "pixel_8",
      kind: "builtin",
      name: "Pixel 8",
    });
    await expect(source.resolve("PIXEL_8")).resolves.toEqual({
      avdmanagerId: "pixel_8",
      kind: "builtin",
      name: "Pixel 8",
    });
    await expect(source.resolve("Pixel Fold")).resolves.toBeUndefined();
  });

  it("lists resolvable model names", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const source = new BuiltinDeviceProfileSource(avdmanager, runner);

    await expect(source.listModels()).resolves.toEqual(["Pixel 8"]);
  });
});

describe("UserDeviceProfileSource", () => {
  it("resolves a properties profile mapped from devices.xml hardware fields", async () => {
    const filesystem = await filesystemWithDevicesXml(devicesXml());
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem);

    await expect(source.resolve("My Custom Phone")).resolves.toEqual({
      hardwareProperties: {
        "hw.device.manufacturer": "Acme",
        "hw.device.name": "My Custom Phone",
        "hw.lcd.density": "420",
        "hw.lcd.height": "2400",
        "hw.lcd.width": "1080",
        "hw.ramSize": "6144",
      },
      kind: "properties",
      name: "My Custom Phone",
    });
  });

  it("resolves nothing for a model it does not have", async () => {
    const filesystem = await filesystemWithDevicesXml(devicesXml());
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem);

    await expect(source.resolve("Pixel 8")).resolves.toBeUndefined();
  });

  it("treats an absent file as no profiles without a diagnostic", async () => {
    const filesystem = new MemoryFilesystem();
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.listModels()).resolves.toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("reports malformed devices.xml as a diagnostic instead of throwing", async () => {
    const filesystem = await filesystemWithDevicesXml("not even close to xml {{{");
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.listModels()).resolves.toEqual([]);
    await expect(source.resolve("anything")).resolves.toBeUndefined();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      kind: "device-profile-source-unreadable",
      path: devicesXmlPath,
    });
  });

  it("reports a devices.xml with a newline embedded in a device name as a diagnostic and produces no profile", async () => {
    // Stands in for `<d:manufacturer>Google\ndisk.dataPartition.path=/evil</d:manufacturer>`:
    // a value that would inject an arbitrary extra config.ini line once
    // `AndroidDriver#applyHardwareProperties` merges it in. Embedded directly (not via an XML
    // entity) since `extractText` only trims leading/trailing whitespace, not internal
    // characters.
    const filesystem = await filesystemWithDevicesXml(
      '<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">' +
        "<d:device><d:name>Evil\nPhone</d:name></d:device>" +
        "</d:devices>",
    );
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.listModels()).resolves.toEqual([]);
    await expect(source.resolve("Evil\nPhone")).resolves.toBeUndefined();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      kind: "device-profile-source-unreadable",
      path: devicesXmlPath,
    });
  });

  it("treats a well-formed but empty devices.xml as legitimately profile-less", async () => {
    const filesystem = await filesystemWithDevicesXml(
      '<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7"/>',
    );
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.listModels()).resolves.toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe("parseDevicesXml", () => {
  it("maps named density buckets and KiB ram to config.ini-shaped values", () => {
    const xml = `<?xml version="1.0"?>
      <d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
        <d:device>
          <d:name>Bucket Phone</d:name>
          <d:hardware>
            <d:screen>
              <d:screen-size>normal</d:screen-size>
              <d:pixel-density>xxhdpi</d:pixel-density>
              <d:dimensions>
                <d:x-dimension>1440</d:x-dimension>
                <d:y-dimension>3040</d:y-dimension>
              </d:dimensions>
            </d:screen>
            <d:ram>
              <d:ram-size unit="KiB">4194304</d:ram-size>
            </d:ram>
          </d:hardware>
        </d:device>
      </d:devices>`;

    expect(parseDevicesXml(xml)).toEqual([
      {
        hardwareProperties: {
          "hw.device.name": "Bucket Phone",
          "hw.lcd.density": "480",
          "hw.lcd.height": "3040",
          "hw.lcd.width": "1440",
          "hw.ramSize": "4096",
        },
        name: "Bucket Phone",
      },
    ]);
  });

  it("skips a device with no name", () => {
    const xml = `<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
      <d:device><d:hardware><d:ram><d:ram-size unit="MiB">2048</d:ram-size></d:ram></d:hardware></d:device>
    </d:devices>`;

    expect(parseDevicesXml(xml)).toEqual([]);
  });

  it("rejects a device name containing an embedded line break or NUL byte", () => {
    const withNewline =
      '<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">' +
      "<d:device><d:name>Evil\nPhone</d:name></d:device></d:devices>";
    expect(() => parseDevicesXml(withNewline)).toThrow();

    const withNul =
      '<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">' +
      "<d:device><d:name>Evil\u0000Phone</d:name></d:device></d:devices>";
    expect(() => parseDevicesXml(withNul)).toThrow();
  });

  it("rejects a manufacturer value containing an embedded line break, routing config.ini injection attempts through the same rejection as the name field", () => {
    const xml =
      '<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7"><d:device>' +
      "<d:name>Pixel Knockoff</d:name>" +
      "<d:manufacturer>Google\ndisk.dataPartition.path=/evil</d:manufacturer>" +
      "</d:device></d:devices>";

    expect(() => parseDevicesXml(xml)).toThrow();
  });

  it("returns no profiles for an empty file without throwing", () => {
    expect(parseDevicesXml("")).toEqual([]);
    expect(parseDevicesXml("   \n  ")).toEqual([]);
  });

  it("throws for content with no recognizable <devices> root", () => {
    expect(() => parseDevicesXml("<not-devices-at-all/>")).toThrow();
    expect(() => parseDevicesXml("this is not xml")).toThrow();
  });
});

describe("DeviceProfileRegistry", () => {
  it("resolves the first source's profile when two sources both name the same model", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const filesystem = await filesystemWithDevicesXml(
      devicesXml().replace("My Custom Phone", "Pixel 8"),
    );
    const user = new UserDeviceProfileSource(devicesXmlPath, filesystem);
    const registry = new DeviceProfileRegistry([builtin, user]);

    await expect(registry.resolve("Pixel 8")).resolves.toEqual({
      avdmanagerId: "pixel_8",
      kind: "builtin",
      name: "Pixel 8",
    });
  });

  it("falls through to a later source when the first has no match", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const filesystem = await filesystemWithDevicesXml(devicesXml());
    const user = new UserDeviceProfileSource(devicesXmlPath, filesystem);
    const registry = new DeviceProfileRegistry([builtin, user]);

    await expect(registry.resolve("My Custom Phone")).resolves.toEqual({
      hardwareProperties: {
        "hw.device.manufacturer": "Acme",
        "hw.device.name": "My Custom Phone",
        "hw.lcd.density": "420",
        "hw.lcd.height": "2400",
        "hw.lcd.width": "1080",
        "hw.ramSize": "6144",
      },
      kind: "properties",
      name: "My Custom Phone",
    });
  });

  it("rejects an unresolvable model with UnknownModelError", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const registry = new DeviceProfileRegistry([builtin]);

    await expect(registry.resolve("Nope")).rejects.toMatchObject({ name: "UnknownModelError" });
  });

  it("dedupes listModels by name, earliest source winning", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const filesystem = await filesystemWithDevicesXml(
      devicesXml().replace("My Custom Phone", "pixel 8"),
    );
    const user = new UserDeviceProfileSource(devicesXmlPath, filesystem);
    const registry = new DeviceProfileRegistry([builtin, user]);

    await expect(registry.listModels()).resolves.toEqual(["Pixel 8"]);
  });
});

function devicesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
      <d:device>
        <d:name>My Custom Phone</d:name>
        <d:manufacturer>Acme</d:manufacturer>
        <d:hardware>
          <d:screen>
            <d:screen-size>normal</d:screen-size>
            <d:pixel-density>420dpi</d:pixel-density>
            <d:dimensions>
              <d:x-dimension>1080</d:x-dimension>
              <d:y-dimension>2400</d:y-dimension>
            </d:dimensions>
          </d:screen>
          <d:ram>
            <d:ram-size unit="MiB">6144</d:ram-size>
          </d:ram>
        </d:hardware>
      </d:device>
    </d:devices>`;
}

async function filesystemWithDevicesXml(contents: string): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/home/simlock/.android");
  await filesystem.writeFileAtomic(devicesXmlPath, contents);
  return filesystem;
}

function processResult(stdout: string) {
  return {
    match: { args: ["list", "device"], command: avdmanager },
    result: { code: 0, stderr: "", stdout },
  };
}
