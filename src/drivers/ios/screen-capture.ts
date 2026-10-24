import {
  isPhysicalDriverDevice,
  type ScreenCapture,
  type ScreenFeed,
  type ScreenSettings,
  ScreenUnavailableError,
} from "../../core/index.js";
import type { BytePipeLauncher, BytePipeProcess, Clock, Filesystem } from "../../ports/index.js";

export interface IosScreenCaptureOptions {
  readonly command: string;
  // why: a physical iPhone streams through a second program (`simlock-device-capture`); when it did
  // not build on this Mac the option is still set, and the missing file is what refuses the open.
  readonly deviceCommand?: string;
  // why: CoreDevice refuses a stream to an iPhone below iOS 27; the driver reads the iPhone's iOS
  // version through the physical handler, the one place that runs `devicectl` for a phone.
  readonly deviceOsVersion?: (udid: string) => Promise<string | undefined>;
  readonly launcher: BytePipeLauncher;
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** why: absent when the simulators live in Xcode's own set, which the capture program searches by default. */
  readonly deviceSet?: string;
  readonly onLog?: (line: string) => void;
}

// why: closing stdin is the stop the capture program was built for, and it needs a moment to flush
// its last log line; a program that ignores its liveness handle is killed after this, so a stuck
// encoder cannot pin a simulator's framebuffer.
const STOP_GRACE_MS = 2_000;
// why: a SIGKILLed child is reaped by the kernel at once; the bound exists only so a close cannot
// wait forever on an exit that the OS never reports.
const KILL_WAIT_MS = 2_000;
const LOG_TAIL = 20;
const MIN_DEVICE_OS_MAJOR = 27;

// why: a read that fails, a missing version or one that does not parse is no evidence the iPhone is
// too old, so the capture goes on and the device program's own error decides.
async function tooOld(options: IosScreenCaptureOptions, udid: string): Promise<string | undefined> {
  const version = await options.deviceOsVersion?.(udid).catch(() => undefined);
  const major = version === undefined ? undefined : /^(\d+)/.exec(version)?.[1];
  return major !== undefined && Number(major) < MIN_DEVICE_OS_MAJOR ? version : undefined;
}

export function createIosScreenCapture(options: IosScreenCaptureOptions): ScreenCapture {
  // why: only a command that spells a path can be checked; a bare program name is resolved by the
  // OS at spawn, and a failure there is reported with the spawn's own words.
  // why: `unavailable()` speaks only of the simulator program, so a Mac without the device program
  // still reports streaming available; the device program's own absence refuses a physical open.
  const missing = async (): Promise<string | undefined> =>
    options.command.includes("/") && !(await options.filesystem.exists(options.command))
      ? `No screen capture program at ${options.command}`
      : undefined;

  const missingDeviceProgram = async (): Promise<string | undefined> => {
    const command = options.deviceCommand;
    if (command === undefined)
      return "Physical iPhone streams need simlock-device-capture, which this worker was not given";
    // why: only a command that spells a path can be checked before spawn; a bare program name is
    // resolved by the OS and a failure there is reported with the spawn's own words.
    if (!command.includes("/") || (await options.filesystem.exists(command))) return undefined;
    return `Physical iPhone streams need simlock-device-capture, which did not build on this Mac (it needs Xcode 27 or later, CoreDevice 642 or later); there is none at ${command}`;
  };

  return {
    open: async (device, settings, signal) => {
      const physical = isPhysicalDriverDevice(device);
      const reason = physical ? await missingDeviceProgram() : await missing();
      if (reason !== undefined) throw new ScreenUnavailableError(reason);
      const oldVersion = physical ? await tooOld(options, device.deviceId) : undefined;
      if (oldVersion !== undefined) {
        throw new ScreenUnavailableError(
          `Physical iPhone streams need iOS 27 or later on the iPhone; ${device.deviceId} runs iOS ${oldVersion}. Update the iPhone and ask for the stream again.`,
        );
      }
      if (signal.aborted)
        throw new ScreenUnavailableError("The capture was stopped before it started");
      return startCapture(options, device.deviceId, settings, physical);
    },
    unavailable: missing,
  };
}

function startCapture(
  options: IosScreenCaptureOptions,
  udid: string,
  settings: ScreenSettings,
  physical: boolean,
): ScreenFeed {
  const tail: string[] = [];
  const child = options.launcher.start(
    physical ? (options.deviceCommand ?? "") : options.command,
    [
      udid,
      "--codec",
      "avcc",
      "--fps",
      String(settings.fps),
      "--bitrate",
      String(settings.bitrateKbps * 1_000),
      "--max-dimension",
      String(settings.maxDimension),
    ],
    {
      // why: the environment the daemon carries must not reach either program: a device set named for
      // a simulator would send the device program looking in the wrong place, and a
      // SIMLOCK_COREDEVICE_INFO_PLIST from outside would let the daemon's environment pick which
      // CoreDevice the iPhone stream believes it is running against.
      env: envFor(options, physical),
      onStderrLine: (line) => {
        tail.push(line);
        if (tail.length > LOG_TAIL) tail.shift();
        options.onLog?.(line);
      },
    },
  );
  const close = once(() => stop(child, options.clock));
  return { body: bodyOf(child, tail, close), close };
}

function envFor(options: IosScreenCaptureOptions, physical: boolean): NodeJS.ProcessEnv {
  const {
    SIMLOCK_COREDEVICE_INFO_PLIST: _coreDevicePlist,
    SIMLOCK_IOS_DEVICE_SET: _daemonDeviceSet,
    ...environment
  } = options.baseEnvironment;
  return physical || options.deviceSet === undefined
    ? environment
    : { ...environment, SIMLOCK_IOS_DEVICE_SET: options.deviceSet };
}

// why: a program that dies mid-picture ends its stdout like one that finished, so the body asks how
// it exited and fails with its last log line rather than ending cleanly -- a viewer must be able to
// tell a simulator that shut down from a stream that was asked to stop.
function bodyOf(
  child: BytePipeProcess,
  tail: readonly string[],
  close: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = child.stdout.getReader();
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      await reader.cancel(reason).catch(() => undefined);
      await close();
    },
    pull: async (controller) => {
      const step = await reader.read().catch((error: unknown) => ({ error }));
      if ("error" in step) {
        await close();
        controller.error(step.error);
        return;
      }
      if (!step.done) {
        controller.enqueue(step.value);
        return;
      }
      const exit = await child.exited;
      await close();
      if (exit.code === 0) controller.close();
      else {
        const how =
          exit.error ??
          (exit.signal === null
            ? `exited with code ${String(exit.code)}`
            : `was killed by ${exit.signal}`);
        const last = tail.at(-1);
        controller.error(
          new Error(`The screen capture program ${how}${last === undefined ? "" : `: ${last}`}`),
        );
      }
    },
  });
}

async function stop(child: BytePipeProcess, clock: Clock): Promise<void> {
  child.closeStdin();
  if (await exitsWithin(child, clock, STOP_GRACE_MS)) return;
  child.kill("SIGKILL");
  await exitsWithin(child, clock, KILL_WAIT_MS);
}

function exitsWithin(child: BytePipeProcess, clock: Clock, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = clock.setTimer(ms, () => resolve(false));
    void child.exited.then(() => {
      clock.cancel(timer);
      resolve(true);
    });
  });
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => (running ??= fn());
}
