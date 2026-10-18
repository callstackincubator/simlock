import { randomInt } from "node:crypto";

import {
  encodeScreenFrame,
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type ScreenCapture,
  type ScreenFeed,
  type ScreenSettings,
  ScreenUnavailableError,
  SCREEN_FRAME_TAG,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import type {
  Clock,
  Filesystem,
  ProcessHandle,
  ProcessResult,
  TcpStream,
} from "../../../ports/index.js";
import { ChunkReader, openDeviceSocket } from "./adb-socket.js";
import { EnvelopeMapper } from "./envelope.js";
import { ScrcpyVideoParser } from "./scrcpy-video.js";

// why: the server refuses to start unless its first argument equals the version it was built as, so
// this must match the vendored jar byte for byte.
const SCRCPY_SERVER_VERSION = "5.0.1";
const DEVICE_DIRECTORY = "/data/local/tmp";
const PUSH_TIMEOUT_MS = 30_000;
// why: a phone's screen state is read before anything is pushed, and read again only after a wake; a read that outlives this
// goes on to the push rather than refusing, because only a read that says off is a fact about the screen.
const SCREEN_READ_TIMEOUT_MS = 10_000;
const WAKEFULNESS_LINE = /^\s*mWakefulness=(\S+)\s*$/;
const WAKE_TIMEOUT_MS = 10_000;
const SCREEN_OFF_MESSAGE =
  "The phone's screen is off and did not turn on. Turn it on and ask for the stream again.";
// why: measured from the moment the push returned, through every connect retry, to the first session
// packet; the budget never restarts, so a server that keeps refusing cannot hold a viewer longer.
export const START_DEADLINE_MS = 15_000;
// why: scrcpy's own client retries its connection every 100 ms while the server starts.
export const CONNECT_RETRY_MS = 100;
// why: scrcpy's own client gives the server one second to exit after its sockets close, then kills
// the adb process that runs it.
const SHELL_EXIT_GRACE_MS = 1_000;
const REMOVE_TIMEOUT_MS = 3_000;
export const CLOSE_DEADLINE_MS = 5_000;
// why: scrcpy's encoder repeats a still picture once and then sends nothing until the screen changes,
// so a still screen would look exactly like a dead capture to every silence bound downstream. While
// the socket is open the session says so with an empty `alive` frame, well inside those bounds.
export const ALIVE_AFTER_MS = 5_000;
const ALIVE_FRAME = encodeScreenFrame(SCREEN_FRAME_TAG.alive, new Uint8Array(0));
const QUIET = Symbol("quiet");
const LOG_TAIL_LINES = 20;
const SCID_LIMIT = 2 ** 31;

// why: where one device's scrcpy session runs, as the driver builds it. An emulator's target runs
// `adb -s <serial> …` with Simlock's scoped env and connects to Simlock's own adb server; a physical
// phone's runs `adb -P 5037 …` with the shared server's env, behind that server's version check. The
// capture never names a port and never runs that check: the target is the one place that knows both.
export interface ScreenTarget {
  readonly serial: string;
  // why: `args` start at the adb subcommand; the target aims them at its device. A promise so a
  // phone's version check can run before the process starts; an emulator's resolves at once.
  spawn(args: readonly string[]): Promise<ProcessHandle>;
  run(args: readonly string[], timeoutMs: number): Promise<ProcessResult>;
  // why: a raw connection to the adb server this target's device is reached through.
  connect(timeoutMs: number): Promise<TcpStream>;
}

export interface AndroidScreenCaptureOptions {
  readonly clock: Clock;
  readonly filesystem: Filesystem;
  readonly serverPath: string;
  readonly scid?: () => number;
  // why: where this device's session runs, built by the driver: an emulator's `adb` with Simlock's
  // own env and server, a physical phone's `adb -P 5037` behind the shared server's version check.
  targetFor(device: VirtualDriverDevice | PhysicalDriverDevice): Promise<ScreenTarget>;
}

export function createAndroidScreenCapture(options: AndroidScreenCaptureOptions): ScreenCapture {
  const unavailable = async (): Promise<string | undefined> =>
    (await options.filesystem.exists(options.serverPath))
      ? undefined
      : `Android screen streams need scrcpy-server v${SCRCPY_SERVER_VERSION}, and it is not at ${options.serverPath}`;
  return {
    open: async (
      device: VirtualDriverDevice | PhysicalDriverDevice,
      settings: ScreenSettings,
      signal: AbortSignal,
    ): Promise<ScreenFeed> => {
      const reason = await unavailable();
      if (reason !== undefined) throw new ScreenUnavailableError(reason);
      const target = await options.targetFor(device);
      const scid = options.scid?.() ?? randomInt(0, SCID_LIMIT);
      return await new ScrcpySession(
        options.clock,
        options.serverPath,
        target,
        scid,
        settings,
        isPhysicalDriverDevice(device),
      ).start(signal);
    },
    unavailable,
  };
}

class ScrcpySession {
  readonly #clock: Clock;
  readonly #serverPath: string;
  readonly #target: ScreenTarget;
  readonly #scidHex: string;
  readonly #devicePath: string;
  readonly #settings: ScreenSettings;
  readonly #isPhone: boolean;
  readonly #tail: string[] = [];
  readonly #abort = new AbortController();
  #pushed = false;
  #shell: ProcessHandle | undefined;
  #shellExited = false;
  #collected: Promise<void> | undefined;
  #stream: TcpStream | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    clock: Clock,
    serverPath: string,
    target: ScreenTarget,
    scid: number,
    settings: ScreenSettings,
    isPhone: boolean,
  ) {
    if (!Number.isInteger(scid) || scid < 0 || scid >= SCID_LIMIT) {
      throw new RangeError(`A scrcpy session id is a 31-bit number, not ${String(scid)}`);
    }
    this.#isPhone = isPhone;
    this.#clock = clock;
    this.#serverPath = serverPath;
    this.#target = target;
    // why: the server parses `scid` as hex and names its socket `scrcpy_%08x`, exactly as scrcpy's
    // own client formats it, so one formatting serves the argument, the socket and the file name.
    this.#scidHex = scid.toString(16).padStart(8, "0");
    this.#devicePath = `${DEVICE_DIRECTORY}/simlock-scrcpy-${this.#scidHex}.jar`;
    this.#settings = settings;
  }

  async start(stopped: AbortSignal): Promise<ScreenFeed> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    const stop = () => this.#abort.abort();
    stopped.addEventListener("abort", stop, { once: true });
    try {
      if (stopped.aborted) throw this.#startFailure("was stopped before it started");
      if (this.#isPhone) await this.#wakeIfOff();
      await this.#push();
      // why: the push is the one step that cannot be interrupted; a stop that arrived during it
      // starts no server on a device that is being handed back.
      if (this.#abort.signal.aborted)
        throw this.#startFailure("was stopped while it was being copied");
      const startedAt = await this.#spawnServer();
      const deadlineAt = startedAt + START_DEADLINE_MS;
      timer = this.#clock.setTimer(START_DEADLINE_MS, () => {
        this.#abort.abort();
      });
      const reader = await this.#connect(deadlineAt);
      const parser = new ScrcpyVideoParser();
      const mapper = new EnvelopeMapper(this.#settings.fps);
      const pending = await this.#untilSized(reader, parser, mapper);
      return { body: this.#body(reader, parser, mapper, pending), close: () => this.close() };
    } catch (error) {
      await this.close();
      throw error instanceof ScreenUnavailableError
        ? error
        : new ScreenUnavailableError(this.#withTail(errorMessage(error)));
    } finally {
      stopped.removeEventListener("abort", stop);
      if (timer !== undefined) this.#clock.cancel(timer);
    }
  }

  async #untilSized(
    reader: ChunkReader,
    parser: ScrcpyVideoParser,
    mapper: EnvelopeMapper,
  ): Promise<Uint8Array[]> {
    const pending: Uint8Array[] = [];
    let sized = false;
    while (!sized) {
      const chunk = await reader.read();
      if (chunk === undefined) throw this.#startFailure("ended before it named the picture's size");
      for (const event of parser.push(chunk)) {
        if (event.kind === "session") sized = true;
        pending.push(...mapper.map(event));
      }
    }
    return pending;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  // why: each of the three steps cannot be cut short from outside; a stop that arrived during one
  // waits for it to end and runs nothing after it, so a device being handed back gets no more keys.
  async #wakeIfOff(): Promise<void> {
    const wasOff = await this.#screenIsOff();
    this.#throwIfStopped("the phone's screen was being read");
    if (!wasOff) return;
    // why: the wake's exit is not looked at; the second read decides. A closed check still throws.
    await this.#target.run(["shell", "input", "keyevent", "KEYCODE_WAKEUP"], WAKE_TIMEOUT_MS);
    this.#throwIfStopped("the phone was being woken");
    const stillOff = await this.#screenIsOff();
    this.#throwIfStopped("the phone's screen was being read");
    if (stillOff) throw new ScreenUnavailableError(SCREEN_OFF_MESSAGE);
  }

  #throwIfStopped(during: string): void {
    if (this.#abort.signal.aborted) throw this.#startFailure(`was stopped while ${during}`);
  }

  // why: only a read that names Asleep or Dozing is a fact about the screen; every other answer —
  // another word, no line, a non-zero exit, a timed-out read — reads as unknown and goes on.
  async #screenIsOff(): Promise<boolean> {
    const read = await this.#target.run(["shell", "dumpsys", "power"], SCREEN_READ_TIMEOUT_MS);
    if (read.code !== 0) return false;
    for (const line of read.stdout.split("\n")) {
      const word = WAKEFULNESS_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line)?.[1];
      if (word === undefined) continue;
      return word === "Asleep" || word === "Dozing";
    }
    return false;
  }

  async #push(): Promise<void> {
    const result = await this.#target.run(
      ["push", this.#serverPath, this.#devicePath],
      PUSH_TIMEOUT_MS,
    );
    // why: a push that timed out may still have written part of the file, so cleanup removes it too.
    this.#pushed = true;
    if (result.code !== 0) {
      throw new ScreenUnavailableError(
        `adb could not copy the screen server to ${this.#target.serial}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
  }

  // why: resolves with the moment the server's process started -- the 15 s budget begins there, so a
  // phone's version check before the spawn does not spend it.
  async #spawnServer(): Promise<number> {
    const { fps, maxDimension, bitrateKbps } = this.#settings;
    const shell = await this.#target.spawn([
      "shell",
      `CLASSPATH=${this.#devicePath}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      SCRCPY_SERVER_VERSION,
      `scid=${this.#scidHex}`,
      "log_level=info",
      "tunnel_forward=true",
      "video=true",
      "audio=false",
      "control=false",
      "video_codec=h264",
      "send_device_meta=false",
      "send_dummy_byte=true",
      "send_stream_meta=true",
      "send_frame_meta=true",
      "cleanup=true",
      // why: scrcpy puts the phone's stay-awake setting back when the server ends (its clean-up
      // process), and needs no controller for it; an emulator's screen is not held.
      ...(this.#isPhone ? ["stay_awake=true"] : []),
      `max_size=${String(maxDimension)}`,
      `max_fps=${String(fps)}`,
      `video_bit_rate=${String(bitrateKbps * 1000)}`,
    ]);
    this.#shell = shell;
    // why: the drain is kept, not fired away: a failure is reported with the server's last output, and
    // a message built while that output is still in flight would say "exited" with nothing from it.
    this.#collected = Promise.all([this.#collect(shell.stdout), this.#collect(shell.stderr)]).then(
      () => undefined,
    );
    void shell.wait().then(
      () => this.#onShellExit(),
      () => this.#onShellExit(),
    );
    return this.#clock.now();
  }

  #onShellExit(): void {
    this.#shellExited = true;
    // why: the abort is delayed until the server's output has been collected, so the failure it
    // triggers names that output instead of racing it to the last line.
    void (this.#collected ?? Promise.resolve()).then(() => {
      this.#abort.abort();
    });
  }

  async #collect(lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        this.#tail.push(line);
        if (this.#tail.length > LOG_TAIL_LINES) this.#tail.shift();
      }
    } catch {
      // why: the output is only the reason a failure is reported with; losing it loses no stream.
    }
  }

  async #connect(deadlineAt: number): Promise<ChunkReader> {
    const signal = this.#abort.signal;
    let last = "no attempt finished";
    for (;;) {
      if (signal.aborted) throw this.#startFailure(`did not accept a connection (${last})`);
      const attempt = await this.#attempt(deadlineAt, signal);
      if (typeof attempt !== "string") return attempt;
      last = attempt;
      await this.#sleep(CONNECT_RETRY_MS, signal);
    }
  }

  async #attempt(deadlineAt: number, signal: AbortSignal): Promise<ChunkReader | string> {
    try {
      const outcome = await openDeviceSocket({
        connect: (timeoutMs) => this.#target.connect(timeoutMs),
        serial: this.#target.serial,
        signal,
        socketName: `scrcpy_${this.#scidHex}`,
        timeoutMs: Math.max(1, deadlineAt - this.#clock.now()),
      });
      if (outcome.kind === "no-transport") {
        throw new ScreenUnavailableError(
          `adb cannot reach ${this.#target.serial}: ${outcome.reason}`,
        );
      }
      if (outcome.kind !== "open") return outcome.reason;
      this.#stream = outcome.stream;
      if (signal.aborted) outcome.stream.close();
      else signal.addEventListener("abort", () => outcome.stream.close(), { once: true });
      // why: the server writes one zero byte the moment it accepts, so a connection that ends
      // before it is one that reached nothing and is retried.
      const dummy = await outcome.reader.readExactly(1);
      if (dummy?.[0] === 0) return outcome.reader;
      outcome.stream.close();
      return dummy === undefined
        ? "the socket closed before the server spoke"
        : "the socket is not scrcpy's";
    } catch (error) {
      if (error instanceof ScreenUnavailableError) throw error;
      return errorMessage(error);
    }
  }

  #sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = this.#clock.setTimer(delayMs, () => {
        signal.removeEventListener("abort", wake);
        resolve();
      });
      const wake = () => {
        this.#clock.cancel(timer);
        resolve();
      };
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  #startFailure(what: string): ScreenUnavailableError {
    const server = `The screen server on ${this.#target.serial}`;
    const reason = this.#shellExited
      ? `${server} exited before it streamed`
      : this.#abort.signal.aborted
        ? `${server} did not start streaming within ${String(START_DEADLINE_MS / 1000)} s: it ${what}`
        : `${server} ${what}`;
    return new ScreenUnavailableError(this.#withTail(reason));
  }

  #withTail(message: string): string {
    return this.#tail.length === 0
      ? message
      : `${message}. Its last output:\n${this.#tail.join("\n")}`;
  }

  #body(
    reader: ChunkReader,
    parser: ScrcpyVideoParser,
    mapper: EnvelopeMapper,
    pending: Uint8Array[],
  ): ReadableStream<Uint8Array> {
    // why: a read the quiet timer outran is still owed its chunk; the next pull awaits that read
    // rather than starting a second one, which would deliver the stream's bytes out of order.
    let inflight: Promise<Uint8Array | undefined> | undefined;
    // why: alive means "the picture you have is still the picture", so nothing is said to be alive
    // before a first picture exists; an encoder that never paints one meets the silence bound.
    let started = false;
    return new ReadableStream<Uint8Array>(
      {
        // why: the socket is read only when the body's reader asks for a frame, so a viewer that
        // falls behind stops this read, TCP stops the adb transport, and the device's encoder
        // waits; nothing is dropped and nothing queues here beyond one socket read.
        // fallow-ignore-next-line complexity -- one read: a frame, the quiet signal, or the end.
        pull: async (controller) => {
          try {
            while (pending.length === 0) {
              inflight ??= reader.read();
              const chunk = started ? await this.#readOrQuiet(inflight) : await inflight;
              if (chunk === QUIET) {
                controller.enqueue(ALIVE_FRAME);
                return;
              }
              inflight = undefined;
              if (chunk === undefined) {
                if (this.#closing !== undefined) controller.close();
                else
                  controller.error(
                    new ScreenUnavailableError(
                      this.#withTail("The screen server stopped streaming"),
                    ),
                  );
                void this.close();
                return;
              }
              for (const event of parser.push(chunk)) pending.push(...mapper.map(event));
            }
            const frame = pending.shift();
            if (frame !== undefined) {
              if (frame[4] === SCREEN_FRAME_TAG.keyframe) started = true;
              controller.enqueue(frame);
            }
          } catch (error) {
            controller.error(error);
            void this.close();
          }
        },
        cancel: () => this.close(),
      },
      { highWaterMark: 0 },
    );
  }

  #readOrQuiet(
    read: Promise<Uint8Array | undefined>,
  ): Promise<Uint8Array | undefined | typeof QUIET> {
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimer(ALIVE_AFTER_MS, () => resolve(QUIET));
      read.then(
        (chunk) => {
          this.#clock.cancel(timer);
          resolve(chunk);
        },
        (error: unknown) => {
          this.#clock.cancel(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #close(): Promise<void> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = this.#clock.setTimer(CLOSE_DEADLINE_MS, resolve);
    });
    try {
      await Promise.race([this.#teardown(), bound]);
    } finally {
      if (timer !== undefined) this.#clock.cancel(timer);
    }
  }

  async #teardown(): Promise<void> {
    this.#abort.abort();
    // why: the server exits when a write to its video socket fails, which is the stop it was built
    // for; the kill below only covers a screen so still that the server has nothing to write.
    this.#stream?.close();
    const shell = this.#shell;
    if (shell !== undefined && !(await this.#exitsWithin(shell, SHELL_EXIT_GRACE_MS))) {
      shell.kill("SIGKILL");
      await this.#exitsWithin(shell, SHELL_EXIT_GRACE_MS);
    }
    if (this.#pushed) {
      // why: with cleanup=true the server unlinks its own jar as it starts, so this only matters for
      // a server that never got that far; it runs anyway because that case is not visible from here.
      await this.#target
        .run(["shell", "rm", "-f", this.#devicePath], REMOVE_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }

  async #exitsWithin(shell: ProcessHandle, delayMs: number): Promise<boolean> {
    if (this.#shellExited) return true;
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    try {
      return await Promise.race([
        shell.wait().then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = this.#clock.setTimer(delayMs, () => resolve(false));
        }),
      ]);
    } finally {
      if (timer !== undefined) this.#clock.cancel(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
