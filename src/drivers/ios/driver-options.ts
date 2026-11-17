import { join } from "node:path";
import { OwnedRootError, type ScreenCapture } from "../../core/index.js";
import type {
  BytePipeLauncher,
  Clock,
  Filesystem,
  IdGenerator,
  Logger,
  ProcessRunner,
  SqliteDatabase,
  SqliteOpener,
  TcpListenerFactory,
  TcpProbe,
  TcpStreamConnector,
} from "../../ports/index.js";
import type { DeviceInputFactory } from "../../core/index.js";
import type { SilenceFailedFact, WindowFailedFact } from "./boot-courtesies.js";
import type { SlimmedFact, SlimSkippedFact } from "./slim-boot.js";
import { defaultIosDeviceRoot, type IosDriverConfig } from "./definition.js";
import { headlessNeedsDefaultSet } from "./device-set-leftovers.js";
import { createIosDeviceInput } from "./input/index.js";
import { createIosScreenCapture } from "./screen-capture.js";

export interface IosSimctlDriverOptions {
  readonly clock: Clock;
  readonly database: SqliteDatabase;
  readonly driverConfig: Readonly<Record<string, string | number | boolean>>;
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly processRunner: ProcessRunner;
  readonly simlockHome: string;
  readonly uid?: number;
  /** why: the daemon's pid is named in the staging directory of a new root. */
  readonly pid?: number;
  readonly coreSimulatorRoot?: string;
  // why: where CoreSimulator keeps each simulator's log folder, which `simctl delete` leaves behind; with none given the driver deletes no log folder.
  readonly logsRoot?: string;
  // why: how a source's WALs are flushed when it is made; with none given the driver flushes nothing.
  readonly sqliteOpener?: SqliteOpener;
  // why: where launchd_sim keeps each simulator's overrides folder; a test points it elsewhere.
  readonly launchdOverridesRoot?: string;
  readonly onSlimmed?: (fact: SlimmedFact) => void;
  readonly onSlimSkipped?: (fact: SlimSkippedFact) => void;
  /** why: the driver's own keys of the `ios` config section; with no `slim` the driver slims nothing, with no `simulator` it keeps audio on and opens no window. */
  readonly config?: Partial<IosDriverConfig>;
  readonly onSilenceFailed?: (fact: SilenceFailedFact) => void;
  readonly onWindowFailed?: (fact: WindowFailedFact) => void;
  readonly slimByDefault?: boolean;
  // why: the device input logs a Home press that did nothing; nothing else in the driver logs through it.
  readonly logger?: Logger;
  // why: a simulator reaches the worker's loopback, so its tunnels need these three ports from the daemon; with any one missing the driver offers no `deviceTcp`.
  readonly tcpListener?: TcpListenerFactory;
  readonly tcpProbe?: TcpProbe;
  readonly tcpStreamConnector?: TcpStreamConnector;
  // why: absent when this host has no way to run the capture program; the driver then offers no
  // screen at all rather than one that fails on every open.
  readonly screenCapture?: {
    readonly command: string;
    readonly deviceCommand?: string;
    readonly launcher: BytePipeLauncher;
    readonly baseEnvironment: NodeJS.ProcessEnv;
    readonly onLog?: (line: string) => void;
  };
}

// why: the input is offered exactly when the screen capture is, because both are the one program.
export function createInputFor(
  options: IosSimctlDriverOptions,
  deviceRoot: string,
  ownedRoot: boolean,
): DeviceInputFactory | undefined {
  if (options.screenCapture === undefined) return undefined;
  return createIosDeviceInput({
    baseEnvironment: options.screenCapture.baseEnvironment,
    clock: options.clock,
    command: configuredScreenCaptureCommand(options) ?? options.screenCapture.command,
    ...(ownedRoot ? { deviceSet: deviceRoot } : {}),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    launcher: options.screenCapture.launcher,
    processRunner: options.processRunner,
  });
}

function configuredScreenCaptureCommand(options: IosSimctlDriverOptions): string | undefined {
  const configured = options.driverConfig["screenCaptureCommand"];
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

function configuredDeviceCaptureCommand(options: IosSimctlDriverOptions): string | undefined {
  const configured = options.driverConfig["deviceCaptureCommand"];
  return typeof configured === "string" && configured !== "" ? configured : undefined;
}

export function configuredDeviceSet(options: IosSimctlDriverOptions): "simlock" | "default" {
  const configured = options.driverConfig["deviceSet"];
  if (configured === undefined || configured === "simlock") {
    if (options.config?.simulator?.headless === false) throw headlessNeedsDefaultSet("simlock");
    return "simlock";
  }
  if (configured !== "default") {
    throw new OwnedRootError(
      `Refusing the ios device set: drivers.ios.deviceSet must be "simlock" or "default", but it is ${JSON.stringify(configured)}`,
      "invalid-device-set",
      typeof configured === "string" ? configured : JSON.stringify(configured),
      "ios",
    );
  }
  if (options.driverConfig["deviceRoot"] !== undefined) {
    throw new OwnedRootError(
      `Refusing the ios device set: drivers.ios.deviceRoot names Simlock's own set, but drivers.ios.deviceSet is "default". Remove one of them.`,
      "invalid-device-set",
      configured,
      "ios",
    );
  }
  return "default";
}

export function xcodeDeviceSetPath(options: IosSimctlDriverOptions): string {
  return join(options.coreSimulatorRoot ?? ".", "Devices");
}

export function configuredDeviceRoot(options: IosSimctlDriverOptions): string {
  const configured = options.driverConfig["deviceRoot"];

  if (configured !== undefined && typeof configured !== "string") {
    // why: A `deviceRoot` that is not a usable path refuses this platform's *configuration*,
    // which costs iOS and nothing else -- the same as every other refusal here. It is not
    // a daemon-fatal error: `"deviceRoot": true` and `"deviceRoot": "devices/ios"` are one
    // keystroke apart, and killing the process over the first would take Android down with
    // it and leave the reason unreachable, since `doctor` -- where the CLI reference promises
    // it appears -- needs a daemon to answer. `not-absolute` is the vocabulary term the
    // docs already publish for "this names no usable directory"; nothing new is invented.
    throw new OwnedRootError(
      `Refusing the ios device root: drivers.ios.deviceRoot must be an absolute path, but it is the ${typeof configured} ${JSON.stringify(configured)}`,
      "not-absolute",
      String(configured),
      "ios",
    );
  }

  return configured ?? defaultIosDeviceRoot(options.simlockHome);
}

export function createScreenCaptureFor(
  options: IosSimctlDriverOptions,
  deviceRoot: string,
  ownsDeviceSet: boolean,
  deviceOsVersion: (udid: string) => Promise<string | undefined>,
): ScreenCapture | undefined {
  const capture = options.screenCapture;
  if (capture === undefined) return undefined;
  const deviceCommand = configuredDeviceCaptureCommand(options) ?? capture.deviceCommand;
  return createIosScreenCapture({
    baseEnvironment: capture.baseEnvironment,
    clock: options.clock,
    command: configuredScreenCaptureCommand(options) ?? capture.command,
    ...(deviceCommand === undefined ? {} : { deviceCommand }),
    deviceOsVersion,
    ...(ownsDeviceSet ? { deviceSet: deviceRoot } : {}),
    filesystem: options.filesystem,
    launcher: capture.launcher,
    ...(capture.onLog === undefined ? {} : { onLog: capture.onLog }),
  });
}
