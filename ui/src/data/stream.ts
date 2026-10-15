/**
 * why: this file reads a wire format it does not own. The body of `GET /v1/stream/leases/<id>` is the
 * capture program's own envelope, byte for byte — a 4-byte big-endian length covering the tag byte that
 * follows it, a tag, then the payload — because nothing between a simulator's framebuffer and a browser
 * re-frames it: a gateway relays a stream as bytes and never reads one. So the reader has to match the
 * writer's promise exactly, and the one cost of reading it wrong is a picture that never arrives.
 *
 * The envelope is shaped for WebCodecs already: a keyframe's or delta's payload is length-prefixed AVCC
 * NAL units, which is what `VideoDecoder.decode` takes, and the description frame's payload is an `avcC`
 * blob, which is what `configure` takes. Neither is rewritten on the way.
 */

export const TAG = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
  meta: 0x05,
  alive: 0x06,
} as const;

// why: the capture tool refuses a frame longer than 8 MiB, so a header claiming more than that is not a
// big frame but a stream this tool never wrote; the bound is what stops a viewer waiting forever for the
// rest of a length a byte-stream desync invented.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const HEADER_BYTES = 5;

/**
 * why: a decoder holding more frames than this is one the picture is running ahead of, and a live view
 * of a screen is worth its newest frame only — every frame behind it is latency paid for nothing. Past
 * the bound, arriving frames are dropped and the decoder is reset to the encoder's next keyframe: a
 * decoder fed a delta whose neighbours it never saw goes on painting a torn picture, which costs a
 * viewer more than the short wait a reset costs.
 */
const MAX_DECODE_QUEUE = 8;

export type StreamCodec = "h264" | "mjpeg";

export interface StreamMeta {
  readonly codec: StreamCodec;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/**
 * why: three frame counts rather than one, because they answer different questions — the decoder was
 * given it, the browser painted it, or it was dropped rather than drawn behind an earlier one — and
 * the gap between two of them is where a slow viewer's problem lives.
 */
export interface StreamStats {
  readonly fed: number;
  readonly painted: number;
  readonly dropped: number;
  readonly kilobitsPerSecond: number;
  readonly framesPerSecond: number;
  readonly error: string | undefined;
}

/**
 * why: everything a stream learns arrives through one of these rather than through a return value,
 * because what a viewer does with a frame — draw it, count it, close it — is the viewer's business, and
 * this file's job ends at handing frames over in order.
 */
export interface StreamSink {
  onMeta(meta: StreamMeta): void;
  onFrame(frame: VideoFrame): void;
  onImage(image: ImageBitmap): void;
  onStats(stats: StreamStats): void;
  /** why: exactly once however the stream ended, because a pane told twice shows a reason that was
   * already replaced, or two of them at once. */
  onEnd(reason: string | undefined): void;
}

/**
 * why: a stream that fails is closed rather than abandoned. The request *is* the command that keeps the
 * capture running on the worker, so a viewer that has given up on a picture has to let go of it here or
 * the worker goes on producing one for nobody.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  sink: StreamSink,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<void> {
  const reader = body.getReader();
  const clock = new Stopwatch(now);
  const paintedRecently = new RecentRate(now);
  const bytesRecently = new RecentRate(now);
  const counters = {
    decoded: 0,
    dropped: 0,
    fed: 0,
    bytes: 0,
    error: undefined as string | undefined,
  };
  let ended = false;
  let decoder: VideoDecoder | undefined;
  let description: Uint8Array | undefined;
  let meta: StreamMeta | undefined;
  /** why: set when a drop cut the decode chain; nothing after it decodes until the next keyframe. */
  let awaitingKeyframe = false;

  const report = () => {
    const seconds = Math.min(Math.max(clock.elapsed(), 0.001), RATE_WINDOW_MS / 1000);
    sink.onStats({
      dropped: counters.dropped,
      error: counters.error,
      fed: counters.fed,
      framesPerSecond: paintedRecently.total() / seconds,
      kilobitsPerSecond: (bytesRecently.total() * 8) / 1000 / seconds,
      painted: counters.decoded,
    });
  };

  /** why: the first reason a stream dies is the one a viewer is told — a decoder error that arrives
   * afterwards would overwrite the reason the reader already had. */
  const end = (reason?: string) => {
    if (ended) return;
    ended = true;
    if (reason !== undefined && counters.error === undefined) counters.error = reason;
    // why: the figures go out before the end is announced, so the last numbers a viewer is shown name
    // the failure the stream died of rather than the healthy run two frames before it.
    report();
    sink.onEnd(counters.error);
  };

  const fail = (reason: string) => {
    end(reason);
    void reader.cancel(reason).catch(() => undefined);
  };

  const configure = (bytes: Uint8Array): void => {
    const codec = codecString(bytes);
    if (codec === undefined) {
      fail("The stream's parameter sets are not an AVC description");
      return;
    }
    if (decoder === undefined) {
      if (typeof VideoDecoder === "undefined") {
        fail("This browser cannot decode video: it has no WebCodecs");
        return;
      }
      decoder = new VideoDecoder({
        output: (frame) => {
          counters.decoded += 1;
          paintedRecently.add(1);
          sink.onFrame(frame);
          report();
        },
        error: (error) => fail(`The decoder failed: ${message(error)}`),
      });
    }
    decoder.configure({
      codec,
      description: bytes,
      // why: a screen is looked at live, so a frame is worth painting the moment it decodes; a decoder
      // left to its own defaults holds frames to reorder them and adds latency for nothing.
      optimizeForLatency: true,
    });
    description = bytes;
  };

  /** why: a decoder still holding frames made under the old parameter sets has to be emptied before new
   * ones are configured, or the first frame after the change decodes against the wrong picture. */
  const applyDescription = (bytes: Uint8Array) => {
    if (decoder !== undefined) decoder.reset();
    configure(bytes);
    awaitingKeyframe = false;
  };

  const decode = (chunk: Uint8Array, type: "delta" | "key") => {
    if (decoder === undefined) {
      fail("The stream sent video before it sent its parameter sets");
      return;
    }
    if (type === "key") awaitingKeyframe = false;
    else if (awaitingKeyframe) {
      counters.dropped += 1;
      report();
      return;
    }
    counters.fed += 1;
    const each = 1_000_000 / Math.max(meta?.fps ?? 30, 1);
    decoder.decode(
      new EncodedVideoChunk({
        data: chunk,
        duration: each,
        timestamp: counters.fed * each,
        type,
      }),
    );
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      awaitingKeyframe = true;
      counters.dropped += 1;
      decoder.reset();
      if (description !== undefined) configure(description);
      report();
    }
  };

  /** why: one still that cannot be painted is one frame missed, not a dead stream — a stream carried as
   * stills carries no inter-frame state, so the next one is a whole picture on its own. */
  const paintJpeg = async (bytes: Uint8Array) => {
    const image = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer])).catch(
      () => undefined,
    );
    if (image === undefined) return;
    sink.onImage(image);
    counters.decoded += 1;
    paintedRecently.add(1);
    report();
  };

  let buffer: Uint8Array = new Uint8Array(0);

  const applyMeta = (payload: Uint8Array) => {
    const parsed = parseMeta(payload);
    if (parsed.meta === undefined) {
      fail(parsed.error);
      return;
    }
    meta = parsed.meta;
    sink.onMeta(meta);
  };

  // why: a tag this reader does not know -- `alive`, or one a newer capture adds -- is skipped, so a
  // capture can say more than this console understands without breaking the picture.
  const handlers: Readonly<Record<number, (payload: Uint8Array) => void | Promise<void>>> = {
    [TAG.meta]: applyMeta,
    [TAG.description]: (payload) => applyDescription(copy(payload)),
    [TAG.keyframe]: (payload) => decode(copy(payload), "key"),
    [TAG.delta]: (payload) =>
      meta?.codec === "mjpeg" ? paintJpeg(copy(payload)) : decode(copy(payload), "delta"),
    [TAG.seed]: (payload) => paintJpeg(copy(payload)),
  };

  // why: frames are taken off the front of everything read so far, one at a time, because one read
  // can end mid-frame and the next one finishes it.
  const consume = async (chunk: Uint8Array): Promise<boolean> => {
    counters.bytes += chunk.length;
    bytesRecently.add(chunk.length);
    buffer = concat(buffer, chunk);
    for (;;) {
      // why: once a frame has failed, the frames that arrived beside it belong to a stream nobody is
      // reading, and feeding a closed decoder would fail again for a reason a viewer never hears.
      if (ended) return false;
      const next = splitFrame(buffer);
      if (next === "incomplete") return true;
      if (next === "invalid") {
        fail("The stream is not a frame envelope");
        return false;
      }
      buffer = next.rest;
      clock.startIfNeeded();
      await handlers[next.tag ?? -1]?.(next.payload);
    }
  };

  // why: closing the reader is what closes the request, and closing the request is the only
  // off-command this surface has.
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), {
    once: true,
  });

  // why: a still screen sends nothing to report on, and the rate it shows must fall to zero while it
  // is still rather than keep the figure of the last swipe until the next frame arrives.
  const ticker = setInterval(() => {
    if (!ended) report();
  }, 1_000);
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (!(await consume(step.value))) return;
      report();
    }
    end();
  } catch (error) {
    if (signal.aborted) end();
    else fail(message(error));
  } finally {
    clearInterval(ticker);
    try {
      decoder?.close();
    } catch {
      // why: a decoder that failed has closed itself, and a browser refuses the second close; nothing
      // is left running either way.
    }
    if (!ended) void reader.cancel().catch(() => undefined);
  }
}

function splitFrame(
  buffer: Uint8Array,
):
  | "incomplete"
  | "invalid"
  | { readonly tag: number | undefined; readonly payload: Uint8Array; readonly rest: Uint8Array } {
  if (buffer.length < HEADER_BYTES) return "incomplete";
  const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
  // why: the length covers the tag byte as well as the payload, so a frame is one byte shorter than
  // its header claims.
  const total = HEADER_BYTES + length - 1;
  if (length < 1 || total > MAX_FRAME_BYTES) return "invalid";
  if (buffer.length < total) return "incomplete";
  return {
    payload: buffer.subarray(HEADER_BYTES, total),
    rest: buffer.slice(total),
    tag: buffer[4],
  };
}

export type ParsedMeta =
  | { readonly error?: undefined; readonly meta: StreamMeta }
  | { readonly error: string; readonly meta?: undefined };

export function parseMeta(payload: Uint8Array): ParsedMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { error: "The stream's meta frame is not JSON" };
  }
  // why: a codec no browser here decodes is named rather than treated as the one this file was written
  // for, because the alternative is a picture that never arrives and no line explaining it.
  const record = (parsed ?? {}) as Record<string, unknown>;
  const codec = record["codec"];
  if (codec !== "h264" && codec !== "mjpeg") {
    return { error: `This console cannot show a ${String(codec)} stream` };
  }
  const number = (key: string) => (typeof record[key] === "number" ? record[key] : 0);
  return {
    meta: { codec, fps: number("fps"), height: number("height"), width: number("width") },
  };
}

/**
 * why: each of the three parameter bytes is written as exactly two hexadecimal digits, because dropping
 * a leading zero — the thing that trimming usually buys — makes a codec name no browser knows. A
 * simulator's encoder describes itself as `64 00 1e`, and `avc1.6401e` is refused before a frame is
 * tried, so the failure reads as a broken stream rather than as a name.
 */
export function codecString(avcC: Uint8Array): string | undefined {
  const [marker, profile, compatibility, level] = avcC;
  if (
    marker !== 0x01 ||
    profile === undefined ||
    compatibility === undefined ||
    level === undefined
  ) {
    return undefined;
  }
  const part = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${part(profile)}${part(compatibility)}${part(level)}`;
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/** why: a copy, because a subarray shares the buffer a reader handed back, and a chunk outlives the
 * read that produced it. */
function copy(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * why: the span a stream actually ran, not the span the page has been open — a rate averaged over a tab
 * that spent a minute in the background is a number no one can act on.
 */
class Stopwatch {
  #started = 0;
  #running = false;
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  startIfNeeded(): void {
    if (this.#running) return;
    this.#running = true;
    this.#started = this.#now();
  }

  elapsed(): number {
    return this.#running ? (this.#now() - this.#started) / 1000 : 0;
  }
}

/**
 * why: a rate over the last few seconds, not the stream's whole life. A capture that sends only when
 * the screen changes spends most of its life quiet, and a lifetime average shows a swipe running at
 * twenty frames a second as two; this is the rate a viewer is looking at now.
 */
const RATE_WINDOW_MS = 2_000;

class RecentRate {
  readonly #samples: { readonly at: number; readonly amount: number }[] = [];
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  add(amount: number): void {
    this.#samples.push({ amount, at: this.#now() });
  }

  total(): number {
    const since = this.#now() - RATE_WINDOW_MS;
    while (this.#samples.length > 0 && (this.#samples[0]?.at ?? 0) <= since) this.#samples.shift();
    return this.#samples.reduce((sum, sample) => sum + sample.amount, 0);
  }
}
