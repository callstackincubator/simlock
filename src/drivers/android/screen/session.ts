import { randomInt } from "node:crypto";

import {
  encodeScreenFrame,
  isPhysicalDriverDevice,
  type PhysicalDriverDevice,
  type ScreenCapture,
  type ScreenFeed,
  ScreenNotSupportedError,
  type ScreenSettings,
  ScreenUnavailableError,
  SCREEN_FRAME_TAG,
  type VirtualDriverDevice,
} from "../../../core/index.js";
import type {
  Clock,
  Filesystem,
  ProcessHandle,
  ProcessRunner,
  TcpStream,
  TcpStreamConnector,
} from "../../../ports/index.js";
import { ChunkReader, openDeviceSocket } from "./adb-socket.js";
import { EnvelopeMapper } from "./envelope.js";
import { ScrcpyVideoParser } from "./scrcpy-video.js";

// why: the server refuses to start unless its first argument equals the version it was built as, so
// this must match the vendored jar byte for byte.
const SCRCPY_SERVER_VERSION = "5.0.1";
const DEVICE_DIRECTORY = "/data/local/tmp";
const PUSH_TIMEOUT_MS = 30_000;
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

export interface AndroidScreenCaptureOptions {
  readonly adb: string;
  readonly adbServerPort: number;
  readonly clock: Clock;
  readonly env: () => NodeJS.ProcessEnv;
  readonly filesystem: Filesystem;
  readonly processRunner: ProcessRunner;
  readonly serialOf: (device: VirtualDriverDevice) => string;
  readonly serverPath: string;
  readonly tcp: TcpStreamConnector;
  readonly scid?: () => number;
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
      if (isPhysicalDriverDevice(device)) {
        throw new ScreenNotSupportedError(
          "Screen streams are offered for Android emulators only, not for physical Android devices",
        );
      }
      const reason = await unavailable();
      if (reason !== undefined) throw new ScreenUnavailableError(reason);
      const serial = options.serialOf(device);
      if (serial === "") {
        throw new ScreenUnavailableError(
          `${device.deviceId} is not running, so it has no screen to stream`,
        );
      }
      const scid = options.scid?.() ?? randomInt(0, SCID_LIMIT);
      return await new ScrcpySession(options, serial, scid, settings).start(signal);
    },
    unavailable,
  };
}

class ScrcpySession {
  readonly #options: AndroidScreenCaptureOptions;
  readonly #serial: string;
  readonly #scidHex: string;
  readonly #devicePath: string;
  readonly #settings: ScreenSettings;
  readonly #tail: string[] = [];
  readonly #abort = new AbortController();
  #pushed = false;
  #shell: ProcessHandle | undefined;
  #shellExited = false;
  #stream: TcpStream | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    options: AndroidScreenCaptureOptions,
    serial: string,
    scid: number,
    settings: ScreenSettings,
  ) {
    if (!Number.isInteger(scid) || scid < 0 || scid >= SCID_LIMIT) {
      throw new RangeError(`A scrcpy session id is a 31-bit number, not ${String(scid)}`);
    }
    this.#options = options;
    this.#serial = serial;
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
      await this.#push();
      // why: the push is the one step that cannot be interrupted; a stop that arrived during it
      // starts no server on a device that is being handed back.
      if (this.#abort.signal.aborted)
        throw this.#startFailure("was stopped while it was being copied");
      this.#spawnServer();
      const deadlineAt = this.#options.clock.now() + START_DEADLINE_MS;
      timer = this.#options.clock.setTimer(START_DEADLINE_MS, () => {
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
      if (timer !== undefined) this.#options.clock.cancel(timer);
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

  async #push(): Promise<void> {
    const result = await this.#options.processRunner.run(
      this.#options.adb,
      ["-s", this.#serial, "push", this.#options.serverPath, this.#devicePath],
      { env: this.#options.env(), timeoutMs: PUSH_TIMEOUT_MS },
    );
    // why: a push that timed out may still have written part of the file, so cleanup removes it too.
    this.#pushed = true;
    if (result.code !== 0) {
      throw new ScreenUnavailableError(
        `adb could not copy the screen server to ${this.#serial}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
  }

  #spawnServer(): void {
    const { fps, maxDimension, bitrateKbps } = this.#settings;
    const shell = this.#options.processRunner.spawn(
      this.#options.adb,
      [
        "-s",
        this.#serial,
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
        `max_size=${String(maxDimension)}`,
        `max_fps=${String(fps)}`,
        `video_bit_rate=${String(bitrateKbps * 1000)}`,
      ],
      { env: this.#options.env() },
    );
    this.#shell = shell;
    void this.#collect(shell.stdout);
    void this.#collect(shell.stderr);
    void shell.wait().then(
      () => this.#onShellExit(),
      () => this.#onShellExit(),
    );
  }

  #onShellExit(): void {
    this.#shellExited = true;
    this.#abort.abort();
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
        adbServerPort: this.#options.adbServerPort,
        serial: this.#serial,
        signal,
        socketName: `scrcpy_${this.#scidHex}`,
        tcp: this.#options.tcp,
        timeoutMs: Math.max(1, deadlineAt - this.#options.clock.now()),
      });
      if (outcome.kind === "no-transport") {
        throw new ScreenUnavailableError(`adb cannot reach ${this.#serial}: ${outcome.reason}`);
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
      const timer = this.#options.clock.setTimer(delayMs, () => {
        signal.removeEventListener("abort", wake);
        resolve();
      });
      const wake = () => {
        this.#options.clock.cancel(timer);
        resolve();
      };
      signal.addEventListener("abort", wake, { once: true });
    });
  }

  #startFailure(what: string): ScreenUnavailableError {
    const server = `The screen server on ${this.#serial}`;
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
      const timer = this.#options.clock.setTimer(ALIVE_AFTER_MS, () => resolve(QUIET));
      read.then(
        (chunk) => {
          this.#options.clock.cancel(timer);
          resolve(chunk);
        },
        (error: unknown) => {
          this.#options.clock.cancel(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async #close(): Promise<void> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = this.#options.clock.setTimer(CLOSE_DEADLINE_MS, resolve);
    });
    try {
      await Promise.race([this.#teardown(), bound]);
    } finally {
      if (timer !== undefined) this.#options.clock.cancel(timer);
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
      await this.#options.processRunner
        .run(this.#options.adb, ["-s", this.#serial, "shell", "rm", "-f", this.#devicePath], {
          env: this.#options.env(),
          timeoutMs: REMOVE_TIMEOUT_MS,
        })
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
          timer = this.#options.clock.setTimer(delayMs, () => resolve(false));
        }),
      ]);
    } finally {
      if (timer !== undefined) this.#options.clock.cancel(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
