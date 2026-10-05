import { describe, expect, it } from "vitest";

import { MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import {
  BuiltinDeviceProfileSource,
  DeviceProfileRegistry,
  parseAvdmanagerDeviceProfiles,
  parseDevicesXml,
  UserDeviceProfileSource,
  type DeviceProfileSourceDiagnostic,
} from "./device-profile-source.js";

const avdmanager = "/android-sdk/cmdline-tools/latest/bin/avdmanager";
const pixelDevices = `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;
const devicesXmlPath = "/home/simlock/.android/devices.xml";

describe("BuiltinDeviceProfileSource", () => {
  it("lists each profile answering to its name and its avdmanager id", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const source = new BuiltinDeviceProfileSource(avdmanager, runner);

    await expect(source.profiles()).resolves.toEqual([
      {
        avdmanagerId: "pixel_8",
        custom: false,
        deviceClass: "phone",
        kind: "builtin",
        name: "Pixel 8",
        names: ["Pixel 8", "pixel_8"],
      },
    ]);
  });

  it("marks a profile custom only when avdmanager lists it with OEM : User", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(
        `${pixelDevices}---------\n` +
          `id: 68 or "iPhone 13 mini"\n    Name: iPhone 13 mini\n    OEM : User\n---------\n` +
          `id: 69 or "2.7in QVGA"\n    Name: 2.7" QVGA\n    OEM : Generic\n`,
      ),
    ]);
    const source = new BuiltinDeviceProfileSource(avdmanager, runner);

    // SDK profiles first, so the User one moves after `2.7" QVGA`.
    const profiles = await source.profiles();
    expect(
      profiles.map((profile) => [profile.name, "custom" in profile && profile.custom]),
    ).toEqual([
      ["Pixel 8", false],
      ['2.7" QVGA', false],
      ["iPhone 13 mini", true],
    ]);
  });

  it("lists the name once when the avdmanager id equals it ignoring case", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(`Available devices:\nid: 0 or "TV_1080p"\n    Name: tv_1080p\n`),
    ]);
    const source = new BuiltinDeviceProfileSource(avdmanager, runner);

    await expect(source.profiles()).resolves.toEqual([
      {
        avdmanagerId: "TV_1080p",
        custom: false,
        deviceClass: "phone",
        kind: "builtin",
        name: "tv_1080p",
        names: ["tv_1080p"],
      },
    ]);
  });
});

describe("UserDeviceProfileSource", () => {
  it("lists a properties profile mapped from devices.xml hardware fields, answering to its name only", async () => {
    const filesystem = await filesystemWithDevicesXml(devicesXml());
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem);

    await expect(source.profiles()).resolves.toEqual([
      {
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
        names: ["My Custom Phone"],
      },
    ]);
  });

  it("treats an absent file as no profiles without a diagnostic", async () => {
    const filesystem = new MemoryFilesystem();
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.profiles()).resolves.toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("reports malformed devices.xml as a diagnostic instead of throwing", async () => {
    const filesystem = await filesystemWithDevicesXml("not even close to xml {{{");
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const source = new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
      diagnostics.push(diagnostic),
    );

    await expect(source.profiles()).resolves.toEqual([]);
    await expect(source.profiles()).resolves.toEqual([]);
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

    await expect(source.profiles()).resolves.toEqual([]);
    expect(diagnostics).toHaveLength(1);
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

    await expect(source.profiles()).resolves.toEqual([]);
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
            <d:ram unit="KiB">4194304</d:ram>
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

  it("maps ram written as <d:ram unit> with the number as its text, the shape Android Studio writes", () => {
    const xml = `<?xml version="1.0"?>
      <d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
        <d:device>
          <d:name>Studio Phone</d:name>
          <d:hardware>
            <d:keyboard>nokeys</d:keyboard>
            <d:nav>nonav</d:nav>
            <d:ram unit="GiB">2</d:ram>
            <d:buttons>soft</d:buttons>
          </d:hardware>
        </d:device>
      </d:devices>`;

    expect(parseDevicesXml(xml)).toEqual([
      {
        hardwareProperties: {
          "hw.device.name": "Studio Phone",
          "hw.ramSize": "2048",
        },
        name: "Studio Phone",
      },
    ]);
  });

  it.each([
    ["B", "3221225472", "3072"],
    ["KiB", "3145728", "3072"],
    ["MiB", "3072", "3072"],
    ["GiB", "3", "3072"],
    ["TiB", "1", "1048576"],
  ])("converts ram in %s, every unit the devices.xml schema allows, to MiB", (unit, value, mib) => {
    expect(parseDevicesXml(devicesXmlWithRam(`<d:ram unit="${unit}">${value}</d:ram>`))).toEqual([
      {
        hardwareProperties: { "hw.device.name": "Ram Phone", "hw.ramSize": mib },
        name: "Ram Phone",
      },
    ]);
  });

  it.each([
    ["511", undefined],
    ["512", "1"],
    ["1535", "1"],
    ["1536", "2"],
  ])("rounds %s KiB of ram to the nearest MiB", (kib, mib) => {
    const [profile] = parseDevicesXml(devicesXmlWithRam(`<d:ram unit="KiB">${kib}</d:ram>`));
    expect(profile?.hardwareProperties["hw.ramSize"]).toBe(mib);
  });

  it("reads the unit with surrounding whitespace, which the schema's token type allows", () => {
    expect(parseDevicesXml(devicesXmlWithRam('<d:ram unit=" GiB ">2</d:ram>'))).toEqual([
      {
        hardwareProperties: { "hw.device.name": "Ram Phone", "hw.ramSize": "2048" },
        name: "Ram Phone",
      },
    ]);
  });

  it("reads <d:ram> and not a <d:ram-size> element next to it", () => {
    const ram = '<d:ram-size unit="MiB">6144</d:ram-size><d:ram unit="GiB">2</d:ram>';
    expect(parseDevicesXml(devicesXmlWithRam(ram))).toEqual([
      {
        hardwareProperties: { "hw.device.name": "Ram Phone", "hw.ramSize": "2048" },
        name: "Ram Phone",
      },
    ]);
  });

  it.each([
    ["an unknown unit", '<d:ram unit="GB">2</d:ram>'],
    ["a unit in the wrong case", '<d:ram unit="gib">2</d:ram>'],
    ["no unit", "<d:ram>2048</d:ram>"],
    ["a fractional value", '<d:ram unit="GiB">1.5</d:ram>'],
    ["an empty value", '<d:ram unit="GiB"></d:ram>'],
    ["a zero value", '<d:ram unit="GiB">0</d:ram>'],
    ["a value under half a MiB", '<d:ram unit="KiB">511</d:ram>'],
    ["a value too large to count exactly in MiB", '<d:ram unit="TiB">1000000000000000</d:ram>'],
  ])("leaves hw.ramSize unset for ram with %s instead of guessing", (_case, ram) => {
    expect(parseDevicesXml(devicesXmlWithRam(ram))).toEqual([
      { hardwareProperties: { "hw.device.name": "Ram Phone" }, name: "Ram Phone" },
    ]);
  });

  it("skips a device with no name", () => {
    const xml = `<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
      <d:device><d:hardware><d:ram unit="MiB">2048</d:ram></d:hardware></d:device>
    </d:devices>`;

    expect(parseDevicesXml(xml)).toEqual([]);
  });

  // An embedded line break is covered through UserDeviceProfileSource's diagnostic test above.
  it("rejects a device name containing a NUL byte", () => {
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

  // Content that is not XML at all is covered through UserDeviceProfileSource's malformed-file
  // diagnostic test above.
  it("throws for well-formed XML with no recognizable <devices> root", () => {
    expect(() => parseDevicesXml("<not-devices-at-all/>")).toThrow();
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
      custom: false,
      deviceClass: "phone",
      kind: "builtin",
      name: "Pixel 8",
      names: ["Pixel 8", "pixel_8"],
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
      names: ["My Custom Phone"],
    });
  });

  it("does not read a later source once an earlier one resolves the model", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const diagnostics: DeviceProfileSourceDiagnostic[] = [];
    const user = new UserDeviceProfileSource(
      devicesXmlPath,
      await filesystemWithDevicesXml("not even close to xml {{{"),
      (diagnostic) => diagnostics.push(diagnostic),
    );
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(avdmanager, runner),
      user,
    ]);

    await expect(registry.resolve("pixel_8")).resolves.toMatchObject({ name: "Pixel 8" });
    // A read of the malformed devices.xml would have reported it.
    expect(diagnostics).toEqual([]);
  });

  it("resolves a model by any of its names, in any letter case", async () => {
    const runner = new ScriptedProcessRunner([
      processResult(pixelDevices),
      processResult(pixelDevices),
      processResult(pixelDevices),
    ]);
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(avdmanager, runner),
    ]);

    for (const model of ["pixel 8", "PIXEL_8", "Pixel_8"]) {
      await expect(registry.resolve(model)).resolves.toMatchObject({ name: "Pixel 8" });
    }
  });

  it("rejects an unresolvable model with UnknownModelError", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const registry = new DeviceProfileRegistry([builtin]);

    await expect(registry.resolve("Nope")).rejects.toMatchObject({ name: "UnknownModelError" });
  });

  it("dedupes the catalog's models by name, earliest source winning", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const filesystem = await filesystemWithDevicesXml(
      devicesXml().replace("My Custom Phone", "pixel 8"),
    );
    const user = new UserDeviceProfileSource(devicesXmlPath, filesystem);
    const registry = new DeviceProfileRegistry([builtin, user]);

    await expect(registry.catalog()).resolves.toMatchObject({ models: ["Pixel 8"] });
  });

  it("lists a model's other names, only for models that have one", async () => {
    const runner = new ScriptedProcessRunner([processResult(pixelDevices)]);
    const builtin = new BuiltinDeviceProfileSource(avdmanager, runner);
    const user = new UserDeviceProfileSource(
      devicesXmlPath,
      await filesystemWithDevicesXml(devicesXml()),
    );
    const registry = new DeviceProfileRegistry([builtin, user]);

    await expect(registry.catalog()).resolves.toEqual({
      customModels: ["My Custom Phone"],
      modelAliases: { "Pixel 8": ["pixel_8"] },
      modelClasses: { "My Custom Phone": "phone", "Pixel 8": "phone" },
      models: ["Pixel 8", "My Custom Phone"],
    });
  });

  it("does not list another name that an earlier profile answers to", async () => {
    // The second profile's id is the first's in other letter case, so a request for it resolves
    // to the first; listing it under the second would name a model the worker never gives for it.
    const runner = new ScriptedProcessRunner([
      processResult(
        `Available devices:\nid: 0 or "pixel_8"\n    Name: Pixel 8\n---------\n` +
          `id: 1 or "PIXEL_8"\n    Name: Pixel 8 Copy\n`,
      ),
    ]);
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(avdmanager, runner),
    ]);

    await expect(registry.catalog()).resolves.toEqual({
      customModels: [],
      modelAliases: { "Pixel 8": ["pixel_8"] },
      modelClasses: { "Pixel 8": "phone", "Pixel 8 Copy": "phone" },
      models: ["Pixel 8", "Pixel 8 Copy"],
    });
  });

  it("lists a model that comes only from devices.xml in customModels", async () => {
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(pixelDevices)]),
      ),
      new UserDeviceProfileSource(devicesXmlPath, await filesystemWithDevicesXml(devicesXml())),
    ]);

    await expect(registry.catalog()).resolves.toMatchObject({
      customModels: ["My Custom Phone"],
    });
  });

  it("lists a devices.xml model in customModels when avdmanager also lists it as a User profile", async () => {
    // `avdmanager list device` reads devices.xml itself and prints each of its profiles with
    // `OEM : User` (seen on a real SDK, issue #236), so the built-in source returns the name too.
    const withUserProfile =
      `${pixelDevices}---------\n` +
      `id: 1 or "My Custom Phone"\n    Name: My Custom Phone\n    OEM : User\n`;
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(withUserProfile)]),
      ),
      new UserDeviceProfileSource(devicesXmlPath, await filesystemWithDevicesXml(devicesXml())),
    ]);

    await expect(registry.catalog()).resolves.toEqual({
      customModels: ["My Custom Phone"],
      modelAliases: { "Pixel 8": ["pixel_8"] },
      modelClasses: { "My Custom Phone": "phone", "Pixel 8": "phone" },
      models: ["Pixel 8", "My Custom Phone"],
    });
  });

  it("does not list a built-in model in customModels", async () => {
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(pixelDevices)]),
      ),
      new UserDeviceProfileSource(devicesXmlPath, await filesystemWithDevicesXml(devicesXml())),
    ]);

    const catalog = await registry.catalog();
    expect(catalog.models).toContain("Pixel 8");
    expect(catalog.customModels).not.toContain("Pixel 8");
  });

  it("resolves a name avdmanager lists as both an SDK and a User profile to the SDK one, whatever the order", async () => {
    const user = `id: 68 or "My Pixel"\n    Name: Pixel 8\n    OEM : User\n`;
    const sdk = `id: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n`;
    for (const [first, second] of [
      [user, sdk],
      [sdk, user],
    ]) {
      const output = `Available devices:\n${first}---------\n${second}`;
      const registry = new DeviceProfileRegistry([
        new BuiltinDeviceProfileSource(
          avdmanager,
          new ScriptedProcessRunner([processResult(output), processResult(output)]),
        ),
      ]);

      await expect(registry.catalog()).resolves.toMatchObject({
        customModels: [],
        models: ["Pixel 8"],
      });
      await expect(registry.resolve("Pixel 8")).resolves.toMatchObject({
        avdmanagerId: "pixel_8",
        custom: false,
      });
    }
  });

  it("lists a name in both sources once, and not in customModels", async () => {
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(pixelDevices)]),
      ),
      new UserDeviceProfileSource(
        devicesXmlPath,
        await filesystemWithDevicesXml(devicesXml().replace("My Custom Phone", "PIXEL 8")),
      ),
    ]);

    await expect(registry.catalog()).resolves.toMatchObject({
      customModels: [],
      models: ["Pixel 8"],
    });
  });

  it("yields the built-in models and no customModels when devices.xml cannot be read or parsed", async () => {
    // A file that exists but whose read fails, the way a file without read permission does.
    const unreadable = await filesystemWithDevicesXml(devicesXml());
    unreadable.readFile = () =>
      Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    const malformed = await filesystemWithDevicesXml("not even close to xml {{{");

    for (const filesystem of [unreadable, malformed]) {
      const diagnostics: DeviceProfileSourceDiagnostic[] = [];
      const registry = new DeviceProfileRegistry([
        new BuiltinDeviceProfileSource(
          avdmanager,
          new ScriptedProcessRunner([processResult(pixelDevices)]),
        ),
        new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
          diagnostics.push(diagnostic),
        ),
      ]);

      await expect(registry.catalog()).resolves.toMatchObject({
        customModels: [],
        models: ["Pixel 8"],
      });
      // The source was reached and gave up, rather than never being asked.
      expect(diagnostics).toHaveLength(1);
    }
  });

  it("yields the built-in models and an unreadable diagnostic when checking whether devices.xml exists fails", async () => {
    // What `NodeFilesystem.exists` does for anything but ENOENT: an `.android` the daemon may
    // not search (EACCES), or an `.android` that is a file (ENOTDIR).
    const failures = [
      { code: "EACCES", message: `EACCES: permission denied, stat '${devicesXmlPath}'` },
      { code: "ENOTDIR", message: `ENOTDIR: not a directory, stat '${devicesXmlPath}'` },
    ];

    for (const failure of failures) {
      const filesystem = await filesystemWithDevicesXml(devicesXml());
      filesystem.exists = () => Promise.reject(Object.assign(new Error(failure.message), failure));
      const diagnostics: DeviceProfileSourceDiagnostic[] = [];
      const registry = new DeviceProfileRegistry([
        new BuiltinDeviceProfileSource(
          avdmanager,
          new ScriptedProcessRunner([processResult(pixelDevices)]),
        ),
        new UserDeviceProfileSource(devicesXmlPath, filesystem, (diagnostic) =>
          diagnostics.push(diagnostic),
        ),
      ]);

      await expect(registry.catalog()).resolves.toEqual({
        customModels: [],
        modelAliases: { "Pixel 8": ["pixel_8"] },
        modelClasses: { "Pixel 8": "phone" },
        models: ["Pixel 8"],
      });
      expect(diagnostics).toEqual([
        { kind: "device-profile-source-unreadable", path: devicesXmlPath, reason: failure.message },
      ]);
    }
  });

  it("resolves every model in customModels to a properties profile or a custom built-in one", async () => {
    // `pixel_8` is listed, since no earlier profile is named that, but the built-in Pixel 8
    // answers to it, so it resolves to the built-in and must not be marked custom.
    // `iPhone 13 mini` is avdmanager's `OEM : User` entry; `My Custom Phone` is only in
    // devices.xml. Both are custom, by different kinds of profile.
    const twoDevices = devicesXml().replace(
      "</d:devices>",
      "<d:device><d:name>pixel_8</d:name></d:device></d:devices>",
    );
    const withUserProfile =
      `${pixelDevices}---------\n` +
      `id: 68 or "iPhone 13 mini"\n    Name: iPhone 13 mini\n    OEM : User\n`;
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner(Array.from({ length: 3 }, () => processResult(withUserProfile))),
      ),
      new UserDeviceProfileSource(devicesXmlPath, await filesystemWithDevicesXml(twoDevices)),
    ]);

    const catalog = await registry.catalog();
    expect(catalog.models).toEqual(["Pixel 8", "iPhone 13 mini", "My Custom Phone", "pixel_8"]);
    expect(catalog.customModels).toEqual(["iPhone 13 mini", "My Custom Phone"]);
    const resolved = [];
    for (const model of catalog.customModels) {
      const profile = await registry.resolve(model);
      resolved.push(profile.kind === "builtin" ? { custom: profile.custom } : profile.kind);
    }
    expect(resolved).toEqual([{ custom: true }, "properties"]);
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
          <d:ram unit="MiB">6144</d:ram>
        </d:hardware>
      </d:device>
    </d:devices>`;
}

function devicesXmlWithRam(ram: string): string {
  return `<d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">
    <d:device><d:name>Ram Phone</d:name><d:hardware>${ram}</d:hardware></d:device>
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

describe("device classes", () => {
  const entry = (id: string, name: string, tag?: string) =>
    `id: 1 or "${id}"\n    Name: ${name}\n    OEM : Google\n` +
    (tag === undefined ? "" : `    Tag : ${tag}\n`) +
    "---------\n";

  async function modelClasses(output: string, devicesXmlText?: string) {
    const sources = [
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(`Available devices:\n${output}`)]),
      ),
      ...(devicesXmlText === undefined
        ? []
        : [
            new UserDeviceProfileSource(
              devicesXmlPath,
              await filesystemWithDevicesXml(devicesXmlText),
            ),
          ]),
    ];
    return (await new DeviceProfileRegistry(sources).catalog()).modelClasses;
  }

  it("classes a profile by its tag: android-tv is tv, android-wear is watch, android-automotive, android-automotive-playstore and android-automotive-distantdisplay are auto, android-desktop is desktop", async () => {
    const classes = await modelClasses(
      entry("tv", "Television", "android-tv") +
        entry("wear", "Wear Round", "android-wear") +
        entry("auto1", "Auto One", "android-automotive") +
        entry("auto2", "Auto Two", "android-automotive-playstore") +
        entry("auto3", "Auto Three", "android-automotive-distantdisplay") +
        entry("desk", "Desktop Large", "android-desktop"),
    );

    expect(classes).toEqual({
      "Auto One": "auto",
      "Auto Three": "auto",
      "Auto Two": "auto",
      "Desktop Large": "desktop",
      Television: "tv",
      "Wear Round": "watch",
    });
  });

  it("classes an untagged avdmanager profile and a devices.xml profile as phone", async () => {
    const classes = await modelClasses(entry("pixel_8", "Pixel 8"), devicesXml());

    expect(classes).toEqual({ "My Custom Phone": "phone", "Pixel 8": "phone" });
  });

  it("lists no class for a profile whose tag is outside the table, and keeps the model", async () => {
    const output = entry("odd", "Odd Device", "android-toaster") + entry("pixel_8", "Pixel 8");
    const registry = new DeviceProfileRegistry([
      new BuiltinDeviceProfileSource(
        avdmanager,
        new ScriptedProcessRunner([processResult(`Available devices:\n${output}`)]),
      ),
    ]);

    const catalog = await registry.catalog();

    expect(catalog.models).toEqual(["Odd Device", "Pixel 8"]);
    expect(catalog.modelClasses).toStrictEqual({ "Pixel 8": "phone" });
  });
});

describe("parseAvdmanagerDeviceProfiles", () => {
  it("keeps the Tag line of the entry it belongs to and reads none before the first id", () => {
    const output =
      "Available devices:\n    Tag : android-wear\n" +
      'id: 0 or "a"\n    Name: A\n---------\n' +
      'id: 1 or "b"\n    Name: B\n    Tag : android-tv\n' +
      'id: 2 or "c"\n    Name: C\n    Tag: android-desktop\n' +
      'id: 3 or "d"\n    Name: D\n    Tag  :android-wear\n' +
      'id: 4 or "e"\n    Name: E\n    Some Tag : android-tv\n';

    expect(parseAvdmanagerDeviceProfiles(output).map((p) => [p.name, p.tag])).toEqual([
      ["A", undefined],
      ["B", "android-tv"],
      ["C", "android-desktop"],
      ["D", "android-wear"],
      ["E", undefined],
    ]);
  });
});
