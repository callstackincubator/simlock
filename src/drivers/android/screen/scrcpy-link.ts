import { ScreenUnavailableError } from "../../../core/index.js";
import type { Clock, ProcessHandle, TcpStream } from "../../../ports/index.js";
import { ChunkReader, openDeviceSocket } from "./adb-socket.js";
import type { ScreenTarget } from "./session.js";

// why: the server refuses to start unless its first argument equals the version it was built as, so
// this must match the vendored jar byte for byte.
export const SCRCPY_SERVER_VERSION = "5.0.1";
export const DEVICE_DIRECTORY = "/data/local/tmp";
const PUSH_TIMEOUT_MS = 30_000;
// why: measured from the moment the push returned, through every connect retry, to the first session
// packet; the budget never restarts, so a server that keeps refusing cannot hold a viewer longer.
export const START_DEADLINE_MS = 15_000;
// why: scrcpy's own client gives the server one second to exit after its sockets close, then kills
// the adb process that runs it.
export const SHELL_EXIT_GRACE_MS = 1_000;
export const REMOVE_TIMEOUT_MS = 3_000;
export const CLOSE_DEADLINE_MS = 5_000;
// why: scrcpy's own client retries its connection every 100 ms while the server starts.
export const CONNECT_RETRY_MS = 100;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// why: a stream and a device input each push the one vendored jar to their own per-session path, so
// the copy and its failure message are one function.
export async function pushScrcpyServer(
  target: ScreenTarget,
  serverPath: string,
  devicePath: string,
  // why: called once the push has run, whatever it answered: from then on a file may be on the device.
  onRan: () => void,
): Promise<void> {
  const result = await target.run(["push", serverPath, devicePath], PUSH_TIMEOUT_MS);
  onRan();
  if (result.code !== 0) {
    throw new ScreenUnavailableError(
      `adb could not copy the screen server to ${target.serial}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

interface ScrcpyConnectRequest {
  readonly target: ScreenTarget;
  readonly clock: Clock;
  readonly scidHex: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  // why: the caller words a stop in its own terms (a stream's start, an input's), with the last
  // attempt's reason.
  readonly stopped: (last: string) => Error;
}

export interface ScrcpyConnection {
  readonly reader: ChunkReader;
  readonly stream: TcpStream;
}

// why: the server's socket appears only once it has started, so the client asks until it answers,
// the stop arrives or the deadline passes; the first socket it accepts gets its one zero byte.
export async function connectScrcpySocket(
  request: ScrcpyConnectRequest,
): Promise<ScrcpyConnection> {
  let last = "no attempt finished";
  for (;;) {
    if (request.signal.aborted) throw request.stopped(last);
    const attempt = await attemptConnection(request);
    if (typeof attempt !== "string") return attempt;
    last = attempt;
    await sleep(request.clock, CONNECT_RETRY_MS, request.signal);
  }
}

async function attemptConnection(
  request: ScrcpyConnectRequest,
): Promise<ScrcpyConnection | string> {
  const { target, signal } = request;
  try {
    const outcome = await openDeviceSocket({
      connect: (timeoutMs) => target.connect(timeoutMs),
      serial: target.serial,
      signal,
      socketName: `scrcpy_${request.scidHex}`,
      timeoutMs: Math.max(1, request.deadlineAt - request.clock.now()),
    });
    if (outcome.kind === "no-transport") {
      throw new ScreenUnavailableError(`adb cannot reach ${target.serial}: ${outcome.reason}`);
    }
    if (outcome.kind !== "open") return outcome.reason;
    if (signal.aborted) outcome.stream.close();
    else signal.addEventListener("abort", () => outcome.stream.close(), { once: true });
    // why: the server writes one zero byte the moment it accepts, so a connection that ends
    // before it is one that reached nothing and is retried.
    const dummy = await outcome.reader.readExactly(1);
    if (dummy?.[0] === 0) return { reader: outcome.reader, stream: outcome.stream };
    outcome.stream.close();
    return dummy === undefined
      ? "the socket closed before the server spoke"
      : "the socket is not scrcpy's";
  } catch (error) {
    if (error instanceof ScreenUnavailableError) throw error;
    return errorMessage(error);
  }
}

function sleep(clock: Clock, delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = clock.setTimer(delayMs, () => {
      signal.removeEventListener("abort", wake);
      resolve();
    });
    const wake = () => {
      clock.cancel(timer);
      resolve();
    };
    signal.addEventListener("abort", wake, { once: true });
  });
}

export async function exitsWithin(
  clock: Clock,
  shell: ProcessHandle,
  delayMs: number,
): Promise<boolean> {
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  try {
    return await Promise.race([
      shell.wait().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = clock.setTimer(delayMs, () => resolve(false));
      }),
    ]);
  } finally {
    if (timer !== undefined) clock.cancel(timer);
  }
}
