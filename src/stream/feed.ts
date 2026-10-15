import type { ScreenFeed, ScreenMeta } from "../core/index.js";
import type { Clock, TimerHandle } from "../ports/index.js";
import { MetaFrameScanner } from "./framing.js";

export interface CapturedStream {
  readonly meta: ScreenMeta;
  readonly body: ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface FeedBounds {
  readonly clock: Clock;
  readonly startMs: number;
  readonly silenceMs: number;
}

// why: a cold simulator or an emulator whose encoder is warming up can take seconds to paint its
// first frame, and a capture that never paints must still end; generous, but a bound.
export const DEFAULT_START_MS = 30_000;
// why: a screen that does not change still yields frames -- the iOS capture repaints at an idle floor
// and the Android driver writes an `alive` frame when scrcpy has nothing new -- so this long without a byte is a capture that died without
// saying so, and a viewer must not be left looking at a frozen picture it cannot tell from a live one.
export const DEFAULT_SILENCE_MS = 30_000;

export async function readScreenFeed(
  feed: ScreenFeed,
  bounds: FeedBounds,
): Promise<CapturedStream> {
  const reader = feed.body.getReader();
  const scanner = new MetaFrameScanner();
  const buffered: Uint8Array[] = [];
  const read = (ms: number, what: string) => readWithin(reader, bounds.clock, ms, what);

  try {
    for (;;) {
      const step = await read(bounds.startMs, "its first frame");
      if (step.done) throw new Error("The screen capture ended before it wrote a frame");
      buffered.push(step.value);
      const found = scanner.push(step.value);
      if (found !== undefined) {
        // why: everything read so far goes back on the front in order. The meta frame is what the
        // response head was answered from but a decoder needs it in the body too, and bytes that
        // arrived in the same read as it are the stream's first frames.
        return {
          body: followedBy(
            concat(buffered),
            () => read(bounds.silenceMs, "the next frame"),
            reader,
            feed,
          ),
          close: () => feed.close(),
          meta: found.meta,
        };
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    await feed.close();
    throw error;
  }
}

function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  clock: Clock,
  ms: number,
  what: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let timer: TimerHandle | undefined = clock.setTimer(ms, () => {
      timer = undefined;
      reject(
        new Error(`The screen capture wrote nothing for ${String(ms)}ms while waiting for ${what}`),
      );
    });
    const settle = (outcome: () => void) => {
      if (timer === undefined) return;
      clock.cancel(timer);
      timer = undefined;
      outcome();
    };
    reader.read().then(
      (step) => settle(() => resolve(step)),
      (error: unknown) =>
        settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

function followedBy(
  prefix: Uint8Array,
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  source: ReadableStreamDefaultReader<Uint8Array>,
  feed: ScreenFeed,
): ReadableStream<Uint8Array> {
  let handed = false;
  return new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      await source.cancel(reason).catch(() => undefined);
      await feed.close();
    },
    async pull(controller) {
      if (!handed) {
        handed = true;
        controller.enqueue(prefix);
        return;
      }
      try {
        const step = await read();
        if (step.done) {
          await feed.close();
          controller.close();
        } else controller.enqueue(step.value);
      } catch (error) {
        // why: a read that failed is the capture's end as much as a clean close is, and the device
        // must not go on being filmed for a viewer whose stream already errored.
        void source.cancel().catch(() => undefined);
        await feed.close();
        controller.error(error);
      }
    },
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
