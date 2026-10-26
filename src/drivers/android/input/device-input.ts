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
import type { Clock, Logger, ProcessHandle, TcpStream } from "../../../ports/index.js";
import {
  type ChunkReader,
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
import {
  keycodeOf,
  KEYCODE_APP_SWITCH,
  KEYCODE_BACK,
  KEYCODE_HOME,
  KEYCODE_POWER,
  modifierOf,
} from "./keycodes.js";
import { keycodePacket, scrollPacket, touchPacket } from "./packets.js";
import { readScreenSize, type ScreenSize } from "./display-size.js";

const BUTTON_KEYCODES = {
  app_switcher: KEYCODE_APP_SWITCH,
  back: KEYCODE_BACK,
  home: KEYCODE_HOME,
  lock: KEYCODE_POWER,
} as const;
const SCID_LIMIT = 2 ** 31;
// why: an agent that rotates the device is followed within this long.
const SIZE_POLL_MS = 2_000;

export interface AndroidDeviceInputOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
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
  readonly #configListeners = new Set<(config: InputScreenConfig) => void>();
  #poll: ReturnType<Clock["setTimer"]> | undefined;
  readonly #failedListeners = new Set<(error: Error) => void>();
  #meta = 0;
  #pushed = false;
  #shellExited = false;
  #sizeFailing = false;
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
      const { reader, stream } = await connectScrcpySocket({
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
      void this.#drain(reader);
      this.#pollSize();
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

  send(message: InputMessage): void {
    const size = this.#config;
    if (size === undefined) return;
    if (message.kind === "touch") this.#write(touchPacket(message, size));
    else if (message.kind === "scroll") this.#write(scrollPacket(message, size));
    else if (message.kind === "button") this.#press(BUTTON_KEYCODES[message.button]);
    else this.#key(message.type, message.usage);
  }

  #press(keycode: number): void {
    this.#write(keycodePacket("down", keycode, this.#meta));
    this.#write(keycodePacket("up", keycode, this.#meta));
  }

  // why: a modifier is held in the meta state of every later key until its `up`; it joins the state
  // before its own down and leaves it before its own up, as Android's events carry it.
  #key(type: "down" | "up", usage: number): void {
    const keycode = keycodeOf(usage);
    if (keycode === undefined) return;
    const modifier = modifierOf(usage);
    if (modifier !== undefined) {
      this.#meta = type === "down" ? this.#meta | modifier.meta : this.#meta & ~modifier.meta;
    }
    this.#write(keycodePacket(type, keycode, this.#meta));
  }

  #write(packet: Uint8Array): void {
    void this.#stream?.write(packet).catch(() => undefined);
  }

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    this.#configListeners.add(listener);
    if (this.#config !== undefined) listener(this.#config);
    return () => this.#configListeners.delete(listener);
  }

  onFailed(listener: (error: Error) => void): () => void {
    this.#failedListeners.add(listener);
    return () => this.#failedListeners.delete(listener);
  }

  // why: the server sends the device's messages (clipboard, acknowledgements) on the control socket;
  // none is used, but they are read so the socket never fills, and the read ending is how a server
  // that died is noticed.
  async #drain(reader: ChunkReader): Promise<void> {
    while ((await reader.read()) !== undefined) {
      // why: nothing to do with what the device says; only the end matters.
    }
    if (this.#closing !== undefined) return;
    const error = new Error(`The input server on ${this.#target.serial} closed its control socket`);
    for (const listener of this.#failedListeners) listener(error);
  }

  // why: an agent can rotate the device at any time, and a position is measured against the screen as
  // it is now; a read that is still running is waited for, so reads never pile up on a slow device.
  #pollSize(): void {
    this.#poll = this.#options.clock.setTimer(SIZE_POLL_MS, () => {
      void this.#readAgain();
    });
  }

  async #readAgain(): Promise<void> {
    try {
      const config = configOf(await readScreenSize(this.#target));
      this.#sizeFailing = false;
      const last = this.#config;
      if (last === undefined || config.width !== last.width || config.height !== last.height) {
        this.#config = config;
        for (const listener of this.#configListeners) listener(config);
      }
    } catch (error) {
      // why: a failed read leaves the last size in force and the next read tries again; a device that
      // stays unreadable is logged once, not every 2 s, until a read succeeds.
      if (!this.#sizeFailing) {
        this.#sizeFailing = true;
        this.#options.logger?.warn("Could not read the screen size", {
          reason: error instanceof Error ? error.message : String(error),
          serial: this.#target.serial,
        });
      }
    }
    if (!this.#abort.signal.aborted) this.#pollSize();
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
    if (this.#poll !== undefined) this.#options.clock.cancel(this.#poll);
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
