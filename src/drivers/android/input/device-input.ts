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
  CLOSE_DEADLINE_MS,
  connectScrcpySocket,
  DEVICE_DIRECTORY,
  exitsWithin,
  pushScrcpyServer,
  REMOVE_TIMEOUT_MS,
  SCRCPY_SERVER_VERSION,
  type ScreenTarget,
  SHELL_EXIT_GRACE_MS,
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
    open: async (device: VirtualDriverDevice | PhysicalDriverDevice, signal: AbortSignal) => {
      const target = await options.targetFor(device);
      const scid = options.scid?.() ?? randomInt(0, SCID_LIMIT);
      const input = new AndroidDeviceInput(options, target, scid);
      try {
        return await input.start(signal);
      } catch (error) {
        await input.close();
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
  #pushed = false;
  #shellExited = false;
  #closing: Promise<void> | undefined;

  constructor(options: AndroidDeviceInputOptions, target: ScreenTarget, scid: number) {
    this.#options = options;
    this.#target = target;
    // why: the server parses `scid` as hex and names its socket `scrcpy_%08x`, so one formatting
    // serves the argument, the socket and the file name.
    this.#scidHex = scid.toString(16).padStart(8, "0");
    this.#devicePath = `${DEVICE_DIRECTORY}/simlock-scrcpy-${this.#scidHex}.jar`;
  }

  async start(stopped: AbortSignal): Promise<DeviceInput> {
    const stop = () => this.#abort.abort();
    stopped.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    try {
      this.#config = configOf(await readScreenSize(this.#target));
      await this.#push();
      this.#shell = await this.#target.spawn(this.#serverArgs());
      void this.#shell.wait().then(
        () => this.#onShellExit(),
        () => this.#onShellExit(),
      );
      // why: the budget starts when the server does and never restarts, so a server that keeps
      // refusing cannot hold the open longer.
      timer = this.#options.clock.setTimer(START_DEADLINE_MS, () => this.#abort.abort());
      const { stream } = await connectScrcpySocket({
        clock: this.#options.clock,
        deadlineAt: this.#options.clock.now() + START_DEADLINE_MS,
        scidHex: this.#scidHex,
        signal: this.#abort.signal,
        stopped: (last) =>
          new Error(
            `The input server on ${this.#target.serial} did not accept a connection (${last})`,
          ),
        target: this.#target,
      });
      this.#stream = stream;
      return this;
    } finally {
      stopped.removeEventListener("abort", stop);
      if (timer !== undefined) this.#options.clock.cancel(timer);
    }
  }

  // why: only the gate's refusal is a device that takes no input; a push adb ran and failed is a
  // failed open, though the push reports both as `ScreenUnavailableError`.
  async #push(): Promise<void> {
    let ran = false;
    try {
      await pushScrcpyServer(this.#target, this.#options.serverPath, this.#devicePath, () => {
        ran = true;
        this.#pushed = true;
      });
    } catch (error) {
      if (ran && error instanceof Error) throw new Error(error.message);
      throw error;
    }
  }

  #onShellExit(): void {
    this.#shellExited = true;
    this.#abort.abort();
  }

  #serverArgs(): string[] {
    return [
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
    ];
  }

  send(_message: InputMessage): void {}

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    if (this.#config !== undefined) listener(this.#config);
    return () => undefined;
  }

  onFailed(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const clock = this.#options.clock;
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = clock.setTimer(CLOSE_DEADLINE_MS, resolve);
    });
    try {
      await Promise.race([this.#teardown(), bound]);
    } finally {
      if (timer !== undefined) clock.cancel(timer);
    }
  }

  async #teardown(): Promise<void> {
    this.#abort.abort();
    this.#stream?.close();
    const shell = this.#shell;
    if (shell !== undefined && !this.#shellExited) {
      if (!(await exitsWithin(this.#options.clock, shell, SHELL_EXIT_GRACE_MS))) {
        shell.kill("SIGKILL");
        await exitsWithin(this.#options.clock, shell, SHELL_EXIT_GRACE_MS);
      }
    }
    if (this.#pushed) {
      // why: with cleanup=true a started server unlinks its own jar; this covers one that never got that far.
      await this.#target
        .run(["shell", "rm", "-f", this.#devicePath], REMOVE_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }
}
