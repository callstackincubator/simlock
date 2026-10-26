import { randomInt } from "node:crypto";

import {
  type DeviceInput,
  type DeviceInputFactory,
  type InputMessage,
  type InputScreenConfig,
  type PhysicalDriverDevice,
  ScreenUnavailableError,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import type { Clock, ProcessHandle, TcpStream } from "../../../ports/index.js";
import {
  connectScrcpySocket,
  DEVICE_DIRECTORY,
  pushScrcpyServer,
  SCRCPY_SERVER_VERSION,
  type ScreenTarget,
  START_DEADLINE_MS,
} from "../screen/index.js";
import { readScreenSize, type ScreenSize } from "./display-size.js";

const SCID_LIMIT = 2 ** 31;

export interface AndroidDeviceInputOptions {
  readonly clock: Clock;
  readonly serverPath: string;
  readonly scid?: () => number;
  // why: where this device's input runs, built by the driver with the same targets as its screen
  // capture: an emulator's own adb server, a phone's behind the 5037 check.
  targetFor(device: VirtualDriverDevice | PhysicalDriverDevice): Promise<ScreenTarget>;
}

export function createAndroidDeviceInput(options: AndroidDeviceInputOptions): DeviceInputFactory {
  return {
    open: async (device: VirtualDriverDevice | PhysicalDriverDevice) => {
      const target = await options.targetFor(device);
      const scid = options.scid?.() ?? randomInt(0, SCID_LIMIT);
      try {
        return await new AndroidDeviceInput(options, target, scid).start();
      } catch (error) {
        // why: a phone's closed 5037 check is not a failure of the open but a device that takes no input
        // now, which the socket tells its client apart from a failed open.
        if (error instanceof ScreenUnavailableError) return { unavailable: error.message };
        throw error;
      }
    },
  };
}

function configOf(size: ScreenSize): InputScreenConfig {
  return {
    height: size.height,
    orientation: size.width > size.height ? "landscape_left" : "portrait",
    width: size.width,
  };
}

class AndroidDeviceInput implements DeviceInput {
  readonly #options: AndroidDeviceInputOptions;
  readonly #target: ScreenTarget;
  readonly #scidHex: string;
  readonly #devicePath: string;
  readonly #abort = new AbortController();
  #config: InputScreenConfig | undefined;
  #shell: ProcessHandle | undefined;
  #stream: TcpStream | undefined;

  constructor(options: AndroidDeviceInputOptions, target: ScreenTarget, scid: number) {
    this.#options = options;
    this.#target = target;
    // why: the server parses `scid` as hex and names its socket `scrcpy_%08x`, so one formatting
    // serves the argument, the socket and the file name.
    this.#scidHex = scid.toString(16).padStart(8, "0");
    this.#devicePath = `${DEVICE_DIRECTORY}/simlock-scrcpy-${this.#scidHex}.jar`;
  }

  async start(): Promise<DeviceInput> {
    this.#config = configOf(await readScreenSize(this.#target));
    await pushScrcpyServer(this.#target, this.#options.serverPath, this.#devicePath, () => {});
    this.#shell = await this.#target.spawn([
      "shell",
      `CLASSPATH=${this.#devicePath}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_SERVER_VERSION,
      `scid=${this.#scidHex}`,
      "log_level=info",
      "tunnel_forward=true",
      "video=false",
      "audio=false",
      "control=true",
      "power_on=false",
      "send_device_meta=false",
      "send_dummy_byte=true",
      "cleanup=true",
    ]);
    const { stream } = await connectScrcpySocket({
      clock: this.#options.clock,
      deadlineAt: this.#options.clock.now() + START_DEADLINE_MS,
      scidHex: this.#scidHex,
      signal: this.#abort.signal,
      stopped: (last) => new Error(`The input server did not accept a connection (${last})`),
      target: this.#target,
    });
    this.#stream = stream;
    return this;
  }

  send(_message: InputMessage): void {}

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    if (this.#config !== undefined) listener(this.#config);
    return () => undefined;
  }

  onFailed(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.#abort.abort();
    this.#stream?.close();
    this.#shell?.kill("SIGKILL");
  }
}
