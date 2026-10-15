import {
  isPhysicalDriverDevice,
  type ScreenCapture,
  type ScreenFeed,
  ScreenNotSupportedError,
  type ScreenSettings,
  ScreenUnavailableError,
} from "../../core/index.js";
import type { BytePipeLauncher, BytePipeProcess, Clock, Filesystem } from "../../ports/index.js";

export interface IosScreenCaptureOptions {
  readonly command: string;
  readonly launcher: BytePipeLauncher;
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly deviceSet: string;
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

export function createIosScreenCapture(options: IosScreenCaptureOptions): ScreenCapture {
  // why: only a command that spells a path can be checked; a bare program name is resolved by the
  // OS at spawn, and a failure there is reported with the spawn's own words.
  const missing = async (): Promise<string | undefined> =>
    options.command.includes("/") && !(await options.filesystem.exists(options.command))
      ? `No screen capture program at ${options.command}`
      : undefined;

  return {
    open: async (device, settings, signal) => {
      if (isPhysicalDriverDevice(device)) {
        throw new ScreenNotSupportedError(
          "A physical iPhone's screen cannot be streamed; only a simulator's can",
        );
      }
      const reason = await missing();
      if (reason !== undefined) throw new ScreenUnavailableError(reason);
      if (signal.aborted)
        throw new ScreenUnavailableError("The capture was stopped before it started");
      return startCapture(options, device.deviceId, settings);
    },
    unavailable: missing,
  };
}

function startCapture(
  options: IosScreenCaptureOptions,
  udid: string,
  settings: ScreenSettings,
): ScreenFeed {
  const tail: string[] = [];
  const child = options.launcher.start(
    options.command,
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
      env: { ...options.baseEnvironment, SIMLOCK_IOS_DEVICE_SET: options.deviceSet },
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
