import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { PhysicalInspection } from "../../core/index.js";
import {
  MemoryFilesystem,
  FakeClock,
  type ScriptedProcessExpectation,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../../ports/index.js";
import { IosSimctlDriver } from "./index.js";
import { memorySourceDatabase } from "./testing.js";

export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

export type Fields = Record<string, Json>;

export const lockFixture = JSON.parse(
  readFileSync(new URL("./fixtures/devicectl-lock-state.json", import.meta.url), "utf8"),
) as Fields;

export const appsFixture = JSON.parse(
  readFileSync(new URL("./fixtures/devicectl-info-apps.json", import.meta.url), "utf8"),
) as { readonly result: { readonly apps: readonly Fields[] } };

export const SIMLOCK_HOME = "/home/.simlock";

export const DEVICE_ROOT = "/Devices";

export const READ_LIMIT_MS = 30_000;

export const PHONE_UDID = "00008110-001A2B3C4D5E";

export const PHONE_IDENTIFIER = "C9F5A3E2-6D7B-4A8C-9E4F-3B2A0D9C8E73";

export const PHONE_SERIAL = "F4GXYZ1234";

export const PHONE_ECID = 6368729128779814;

export const PHONE: Fields = {
  deviceType: "iPhone",
  developerModeStatus: "enabled",
  ecid: PHONE_ECID,
  identifier: PHONE_IDENTIFIER,
  isMobileDeviceOnly: false,
  localHostnames: ["Szymons-iPhone.coredevice.local"],
  marketingName: "iPhone 15 Pro",
  name: "Szymon's iPhone",
  osVersionNumber: "18.4",
  pairingState: "paired",
  platform: "iOS",
  productType: "iPhone16,1",
  reality: "physical",
  serialNumber: PHONE_SERIAL,
  transportType: "wired",
  tunnelState: "disconnected",
  udid: PHONE_UDID,
};

export const DEPRECATED_GROUP: Readonly<Record<string, string>> = {
  deviceType: "hardwareProperties",
  developerModeStatus: "deviceProperties",
  ecid: "hardwareProperties",
  isMobileDeviceOnly: "connectionProperties",
  localHostnames: "connectionProperties",
  marketingName: "hardwareProperties",
  name: "deviceProperties",
  osVersionNumber: "deviceProperties",
  pairingState: "connectionProperties",
  platform: "hardwareProperties",
  productType: "hardwareProperties",
  reality: "hardwareProperties",
  serialNumber: "hardwareProperties",
  transportType: "connectionProperties",
  tunnelState: "connectionProperties",
  udid: "hardwareProperties",
};

export const PROPERTIES_GROUP: Readonly<Record<string, string>> = {
  deviceType: "hardware",
  developerModeStatus: "state",
  ecid: "hardware",
  marketingName: "hardware",
  osVersionNumber: "software",
  pairingState: "connection",
  platform: "hardware",
  productType: "hardware",
  reality: "hardware",
  serialNumber: "hardware",
  transportType: "connection",
  udid: "hardware",
};

export function wire(fields: Fields, onlyInProperties: readonly string[] = []): Fields {
  const deprecated: Record<string, Fields> = {
    connectionProperties: {},
    deviceProperties: {},
    hardwareProperties: {},
  };
  const properties: Record<string, Fields> = {
    connection: {},
    hardware: {},
    software: {},
    state: {},
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || field === "identifier") continue;
    const group = DEPRECATED_GROUP[field];
    const fallback = PROPERTIES_GROUP[field];
    const deprecatedTarget = group === undefined ? undefined : deprecated[group];
    const propertiesTarget = fallback === undefined ? undefined : properties[fallback];
    if (deprecatedTarget !== undefined && !onlyInProperties.includes(field)) {
      deprecatedTarget[field] = value;
    }
    if (propertiesTarget !== undefined) propertiesTarget[field] = value;
  }
  return {
    ...deprecated,
    identifier: fields["identifier"],
    properties,
    visibilityClass: "default",
  };
}

export function listDocument(devices: readonly Fields[]): string {
  // why: JSON.parse would round an ECID above 2^53, so a test writes those digits as raw text.
  return JSON.stringify({
    info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
    result: { devices },
  }).replace(/"@ecid:(\d+)"/g, "$1");
}

export function lockDocument(result: Fields): string {
  return JSON.stringify({ ...lockFixture, result });
}

export function appsDocument(bundles: readonly string[]): string {
  const template = appsFixture.result.apps[0] ?? {};
  return JSON.stringify({
    ...appsFixture,
    result: {
      ...appsFixture.result,
      appCount: bundles.length,
      apps: bundles.map((bundle) => ({ ...template, bundleIdentifier: bundle, name: bundle })),
    },
  });
}

export const OPEN_LOCK = lockDocument({ passcodeRequired: false, unlockedSinceBoot: true });

export const LOCKED = lockDocument({ passcodeRequired: true, unlockedSinceBoot: true });

export const LIST_ARGV = ["xcrun", "devicectl", "list", "devices", "--json-output", "<json>"];

export function lockArgv(udid: string): string[] {
  return [
    "xcrun",
    "devicectl",
    "device",
    "info",
    "lockState",
    "--device",
    udid,
    "--json-output",
    "<json>",
  ];
}

export class UmaskFilesystem extends MemoryFilesystem {
  override async mkdirp(path: string): Promise<void> {
    const existed = await this.exists(path);
    await super.mkdirp(path);
    // why: a real mkdirp leaves 0755 under a 022 umask, so only an explicit 0700 passes.
    if (!existed && path.endsWith("/devicectl")) await this.chmod(path, 0o755);
  }
}

export interface ReadScript {
  readonly file?: string;
  readonly exit?: number;
  readonly hangs?: boolean;
}

export class Lab {
  readonly filesystem: MemoryFilesystem = new UmaskFilesystem();
  readonly clock = new FakeClock();
  readonly written: string[] = [];
  readonly #expectations: ScriptedProcessExpectation[] = [];
  #runner: ScriptedProcessRunner | undefined;

  get runner(): ScriptedProcessRunner {
    this.#runner ??= new ScriptedProcessRunner(this.#expectations);
    return this.#runner;
  }

  add(expectation: ScriptedProcessExpectation): this {
    this.#expectations.push(expectation);
    return this;
  }

  list(devices: readonly Fields[] | string, script?: ReadScript): this {
    const file = typeof devices === "string" ? devices : listDocument(devices);
    return this.#read(["list", "devices"], script ?? { file });
  }

  lock(udid: string, script: ReadScript = { file: OPEN_LOCK }): this {
    return this.#read(["device", "info", "lockState", "--device", udid], script);
  }

  apps(udid: string, bundles: readonly string[] | ReadScript): this {
    const script = Array.isArray(bundles)
      ? { file: appsDocument(bundles as readonly string[]) }
      : (bundles as ReadScript);
    return this.#read(["device", "info", "apps", "--device", udid], script);
  }

  uninstall(udid: string, bundle: string, script: ReadScript = {}): this {
    return this.add({
      match: {
        args: ["devicectl", "device", "uninstall", "app", "--device", udid, bundle],
        command: "xcrun",
      },
      result: { code: script.exit ?? 0, stderr: "", stdout: "" },
      ...(script.hangs === true ? { hangs: true } : {}),
    });
  }

  async driver(
    runner: ProcessRunner = this.runner,
    screenCapture?: NonNullable<Parameters<typeof IosSimctlDriver.create>[0]["screenCapture"]>,
  ): Promise<IosSimctlDriver> {
    await this.filesystem.mkdirp(SIMLOCK_HOME);
    return IosSimctlDriver.create({
      database: await memorySourceDatabase(),
      clock: this.clock,
      driverConfig: { deviceRoot: DEVICE_ROOT },
      filesystem: this.filesystem,
      idGenerator: { generate: () => "device-1" },
      instanceId: "instance-1",
      processRunner: runner,
      ...(screenCapture === undefined ? {} : { screenCapture }),
      simlockHome: SIMLOCK_HOME,
    });
  }

  calls(): string[][] {
    return this.runner.calls.map((call) => {
      const argv = [call.command, ...call.args];
      const index = argv.indexOf("--json-output");
      if (index === -1) return argv;
      return argv.map((argument, position) => (position === index + 1 ? "<json>" : argument));
    });
  }

  timeouts(): (number | undefined)[] {
    return this.runner.calls.map((call) => call.options.timeoutMs);
  }

  #read(argv: readonly string[], script: ReadScript): this {
    return this.add({
      match: {
        args: ["devicectl", ...argv, "--json-output", /^\/home\/\.simlock\/devicectl\/[^/]+$/],
        command: "xcrun",
      },
      onSpawn: async (args) => {
        const index = args.indexOf("--json-output");
        const path = args[index + 1];
        if (index === -1 || path === undefined) return;
        this.written.push(path);
        if (script.file === undefined) return;
        try {
          await this.filesystem.writeFileAtomic(path, script.file);
        } catch {
          // why: a driver that never created the directory gets no file, and its read fails on its own.
        }
      },
      result: {
        code: script.exit ?? 0,
        stderr: script.exit === undefined ? "" : "devicectl: failed",
        stdout: "",
      },
      ...(script.hangs === true ? { hangs: true } : {}),
    });
  }
}

export async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function waitForCalls(runner: ScriptedProcessRunner, count: number): Promise<void> {
  for (let turn = 0; turn < 50 && runner.calls.length < count; turn += 1) await turns(1);
  expect(runner.calls.length, "devicectl calls the driver made").toBeGreaterThanOrEqual(count);
}

export async function expireAfter<T>(
  lab: Lab,
  pending: Promise<T>,
  calls: number,
  ms: number,
): Promise<T> {
  void pending.catch(() => undefined);
  await waitForCalls(lab.runner, calls);
  lab.clock.advance(ms);
  return pending;
}

export function enrollableLab(
  devices: readonly Fields[] | string = [wire(PHONE)],
  udid = PHONE_UDID,
  bundles: readonly string[] = ["com.example.MyApp"],
): Lab {
  return new Lab().list(devices).lock(udid).apps(udid, bundles);
}

export async function inspect(lab: Lab, id: string): Promise<PhysicalInspection> {
  return (await lab.driver()).inspectPhysical(id);
}

export const FAILURES = [
  {
    expires: false,
    script: (file: string): ReadScript => ({ exit: 1, file }),
    title: "exits non-zero",
  },
  { expires: false, script: (): ReadScript => ({}), title: "leaves no file" },
  {
    expires: false,
    script: (): ReadScript => ({ file: "devicectl: not json {" }),
    title: "leaves a file that is not JSON",
  },
  {
    expires: true,
    script: (file: string): ReadScript => ({ file, hangs: true }),
    title: "passes 30 s",
  },
] as const;

export function listed(udid: string, extra: Fields = {}): Fields {
  return wire({
    ...PHONE,
    identifier: `ID-${udid}`,
    serialNumber: `SN-${udid}`,
    udid,
    ...extra,
  });
}

export const UDID_A = "00008110-00000000000A";

export const UDID_B = "00008110-00000000000B";
