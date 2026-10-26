import {
  type DeviceInput,
  type DeviceInputFactory,
  encodeScreenFrame,
  INPUT_TAG,
  isPhysicalDriverDevice,
  type InputMessage,
  type InputScreenConfig,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import type {
  BytePipeExit,
  BytePipeLauncher,
  BytePipeProcess,
  Clock,
  Logger,
  ProcessRunner,
} from "../../../ports/index.js";
import { iosRuntimeVersionFromId } from "../runtime-version.js";
import { stopProgram } from "../screen-capture.js";

export interface IosDeviceInputOptions {
  readonly command: string;
  readonly launcher: BytePipeLauncher;
  readonly clock: Clock;
  readonly processRunner: ProcessRunner;
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** why: absent when the simulators live in Xcode's own set, which the helper searches by default. */
  readonly deviceSet?: string;
  readonly logger?: Logger;
}

const FRAME_HEADER_BYTES = 4;
const HOME_TIMEOUT_MS = 10_000;
// why: the helper sets up its HID client before it reports a size; one that never does is stuck, and
// the open must not wait on it (architecture rule 11).
const READY_DEADLINE_MS = 10_000;
const SPRINGBOARD = "com.apple.springboard";

export function createIosDeviceInput(options: IosDeviceInputOptions): DeviceInputFactory {
  return {
    open: async (device: VirtualDriverDevice | PhysicalDriverDevice) => {
      // why: nothing on a physical iPhone injects input (F23); only a simulator has a HID helper.
      if (isPhysicalDriverDevice(device)) {
        return { unavailable: "Input is not supported on physical iPhones" };
      }
      const child = options.launcher.start(options.command, [device.deviceId, "--input"], {
        env: environmentFor(options),
      });
      let size: InputScreenConfig;
      try {
        size = await within(READY_DEADLINE_MS, options.clock, readConfig(child));
      } catch (error) {
        await stopProgram(child, options.clock);
        throw error;
      }
      const keys = keysAvailable(device);
      const config: InputScreenConfig = keys ? size : { ...size, keyboardUnavailable: true };
      return new IosDeviceInput(options, device.deviceId, child, config, keys);
    },
  };
}

// why: the daemon's own device set must not reach the helper, which would search it instead of the
// one this driver owns.
function environmentFor(options: IosDeviceInputOptions): NodeJS.ProcessEnv {
  const { SIMLOCK_IOS_DEVICE_SET: _daemonDeviceSet, ...environment } = options.baseEnvironment;
  return options.deviceSet === undefined
    ? environment
    : { ...environment, SIMLOCK_IOS_DEVICE_SET: options.deviceSet };
}

// why: the iOS 27 guest ignores injected keys (F21), so keys are dropped there; a runtime that cannot
// be read is treated the same, because a key that does nothing is worse than a key refused.
function keysAvailable(device: VirtualDriverDevice | PhysicalDriverDevice): boolean {
  const data = device.driverData as { runtimeId?: unknown } | null;
  const runtimeId = typeof data?.runtimeId === "string" ? data.runtimeId : "";
  const version = iosRuntimeVersionFromId(runtimeId);
  return version !== undefined && version[0] < 27;
}

// why: the helper's stdout is the stream's envelope (a 4-byte length counting the tag, a tag, the
// payload); the first 0x82 is its size, written once its HID client is set up.
async function readConfig(child: BytePipeProcess): Promise<InputScreenConfig> {
  const reader = child.stdout.getReader();
  let buffered = new Uint8Array();
  for (;;) {
    const step = await reader.read();
    if (step.done) {
      const exit = await child.exited;
      throw new Error(
        `The input helper ${describeExit(exit)}${exit.error === undefined ? " before it reported the screen size" : ""}`,
      );
    }
    buffered = Uint8Array.from([...buffered, ...step.value]);
    if (buffered.length < FRAME_HEADER_BYTES) continue;
    const length = new DataView(buffered.buffer).getUint32(0);
    if (buffered.length < FRAME_HEADER_BYTES + length) continue;
    const size = JSON.parse(
      new TextDecoder().decode(
        buffered.subarray(FRAME_HEADER_BYTES + 1, FRAME_HEADER_BYTES + length),
      ),
    ) as { width: number; height: number };
    return { height: size.height, orientation: "portrait", width: size.width };
  }
}

function describeExit(exit: BytePipeExit): string {
  if (exit.error !== undefined) return `could not be started: ${exit.error}`;
  return exit.signal === null
    ? `exited with code ${String(exit.code)}`
    : `was killed by ${exit.signal}`;
}

function within<T>(milliseconds: number, clock: Clock, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimer(milliseconds, () => {
      reject(new Error("The input helper reported no screen size within 10 s"));
    });
    void work.then(resolve, reject).finally(() => clock.cancel(timer));
  });
}

// why: the helper reads serve-sim's JSON for each tag; JSON leaves out a scroll position the client
// sent none of, so the helper scrolls under the centre.
function frameOfMessage(message: Exclude<InputMessage, { kind: "button" }>): Uint8Array {
  switch (message.kind) {
    case "touch":
      return frameOf(INPUT_TAG.touch, { type: message.type, x: message.x, y: message.y });
    case "scroll":
      return frameOf(INPUT_TAG.scroll, {
        dx: message.dx,
        dy: message.dy,
        x: message.x,
        y: message.y,
      });
    case "key":
      return frameOf(INPUT_TAG.key, { type: message.type, usage: message.usage });
  }
}

function frameOf(tag: number, body: unknown): Uint8Array {
  return encodeScreenFrame(tag, new TextEncoder().encode(JSON.stringify(body)));
}

class IosDeviceInput implements DeviceInput {
  readonly #options: IosDeviceInputOptions;
  readonly #udid: string;
  readonly #child: BytePipeProcess;
  readonly #config: InputScreenConfig;
  readonly #keys: boolean;
  readonly #failedListeners = new Set<(error: Error) => void>();
  #closing: Promise<void> | undefined;

  constructor(
    options: IosDeviceInputOptions,
    udid: string,
    child: BytePipeProcess,
    config: InputScreenConfig,
    keys: boolean,
  ) {
    this.#keys = keys;
    void child.exited.then((exit) => {
      this.#fail(new Error(`The input helper ${describeExit(exit)}`));
    });
    this.#options = options;
    this.#udid = udid;
    this.#child = child;
    this.#config = config;
  }

  send(message: InputMessage): void {
    if (message.kind === "button") {
      if (message.button === "home") this.#home();
      return;
    }
    if (message.kind === "key" && !this.#keys) return;
    this.#child.writeStdin(frameOfMessage(message)).catch((error: unknown) => {
      this.#fail(
        new Error(
          `The input helper stopped taking input: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  }

  // why: Xcode 26 and later silently drop the HID home-button press, so Home brings SpringBoard
  // forward the way serve-sim does; the app switcher and Lock have no such way and are dropped.
  #home(): void {
    const { deviceSet, logger, processRunner } = this.#options;
    const args = [
      "simctl",
      ...(deviceSet === undefined ? [] : ["--set", deviceSet]),
      "launch",
      this.#udid,
      SPRINGBOARD,
    ];
    void processRunner.run("xcrun", args, { timeoutMs: HOME_TIMEOUT_MS }).then(
      (result) => {
        if (result.code !== 0)
          logger?.warn("Home did nothing", { stderr: result.stderr, udid: this.#udid });
      },
      (error: unknown) => {
        logger?.warn("Home did nothing", { reason: String(error), udid: this.#udid });
      },
    );
  }

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    listener(this.#config);
    return () => undefined;
  }

  // why: a helper that is closing, or already failed, has told its listeners; a second word would
  // close a socket that is already closed.
  #fail(error: Error): void {
    if (this.#closing !== undefined) return;
    void this.close();
    for (const listener of this.#failedListeners) listener(error);
  }

  onFailed(listener: (error: Error) => void): () => void {
    this.#failedListeners.add(listener);
    return () => this.#failedListeners.delete(listener);
  }

  close(): Promise<void> {
    this.#closing ??= stopProgram(this.#child, this.#options.clock);
    return this.#closing;
  }
}
