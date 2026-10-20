import type { TcpStream } from "../../../ports/index.js";
import {
  ADB_FAIL,
  ADB_LENGTH_BYTES,
  ADB_OKAY,
  ADB_STATUS_BYTES,
  adbHostRequest,
} from "../adb-host-protocol.js";
import { ByteQueue } from "./byte-queue.js";

// why: adb's replies are short, so a reason longer than this is not a reply but a desynced stream.
const MAX_FAIL_REASON_BYTES = 4096;

export class ChunkReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #queue = new ByteQueue();

  constructor(readable: ReadableStream<Uint8Array>) {
    this.#reader = readable.getReader();
  }

  // why: a reply and the bytes after it often share one TCP read, and a chunk smaller than what is
  // asked for is normal; both have to be kept rather than dropped or waited past.
  async readExactly(count: number): Promise<Uint8Array | undefined> {
    while (this.#queue.length < count) {
      const step = await this.#readSource();
      if (step === undefined) return undefined;
      this.#queue.push(step);
    }
    return this.#queue.take(count);
  }

  async read(): Promise<Uint8Array | undefined> {
    if (this.#queue.length > 0) return this.#queue.drain();
    return await this.#readSource();
  }

  async #readSource(): Promise<Uint8Array | undefined> {
    try {
      const step = await this.#reader.read();
      return step.done ? undefined : step.value;
    } catch {
      return undefined;
    }
  }
}

type DeviceSocketOutcome =
  | { readonly kind: "open"; readonly stream: TcpStream; readonly reader: ChunkReader }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "no-transport"; readonly reason: string };

interface DeviceSocketRequest {
  // why: the raw connection is made by the device's target, which owns the choice of adb server:
  // Simlock's own for an emulator, port 5037 for a physical phone.
  readonly connect: (timeoutMs: number) => Promise<TcpStream>;
  readonly serial: string;
  readonly socketName: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

// why: speaking adb's host protocol directly reaches the device socket through the target's adb
// server without an `adb forward`, so a daemon that dies mid-stream leaves no listening port on the
// host. adb answers `localabstract:` with OKAY only once adbd's connect to that socket succeeded, and
// with FAIL "closed" while nothing listens there yet:
// https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/sockets.cpp
export async function openDeviceSocket(request: DeviceSocketRequest): Promise<DeviceSocketOutcome> {
  const stream = await request.connect(request.timeoutMs);
  const onAbort = () => {
    stream.close();
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (request.signal.aborted) stream.close();
    const reader = new ChunkReader(stream.readable);
    await stream.write(adbHostRequest(`host:transport:${request.serial}`));
    const transport = await readReply(reader);
    if (transport !== undefined) {
      stream.close();
      return { kind: "no-transport", reason: transport };
    }
    await stream.write(adbHostRequest(`localabstract:${request.socketName}`));
    const socket = await readReply(reader);
    if (socket !== undefined) {
      stream.close();
      return { kind: "refused", reason: socket };
    }
    return { kind: "open", reader, stream };
  } catch (error) {
    stream.close();
    throw error;
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

class AdbReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbReplyError";
  }
}

async function readReply(reader: ChunkReader): Promise<string | undefined> {
  const status = await reader.readExactly(ADB_STATUS_BYTES);
  if (status === undefined) return "adb closed the connection before it answered";
  const text = ascii(status);
  if (text === ADB_OKAY) return undefined;
  if (text !== ADB_FAIL) throw new AdbReplyError(`adb answered ${JSON.stringify(text)}`);
  const length = await reader.readExactly(ADB_LENGTH_BYTES);
  if (length === undefined) return "adb failed without a reason";
  const size = Number.parseInt(ascii(length), 16);
  if (!/^[0-9a-fA-F]{4}$/.test(ascii(length)) || size > MAX_FAIL_REASON_BYTES) {
    throw new AdbReplyError("adb's failure reason is not length-prefixed");
  }
  const reason = await reader.readExactly(size);
  return reason === undefined ? "adb failed without a reason" : ascii(reason) || "adb failed";
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
