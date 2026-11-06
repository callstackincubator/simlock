import type { Clock } from "../ports/index.js";

/** why: the request body failed on its own (the caller went away), apart from a limit or a write the store raised. */
export class BodyCutError extends Error {
  constructor(cause: unknown) {
    super("The request body ended before it was complete", { cause });
    this.name = "BodyCutError";
  }
}

export interface BodyGuard {
  readonly clock: Clock;
  readonly silenceMs: number;
  readonly onStalled: () => Error;
  readonly onChunk: (chunk: Uint8Array) => void;
}

/**
 * why: an upload's body is read through this, so every limit is checked as the bytes arrive and the
 * silence bound counts from the start or the last byte: a body that breaks one errors the stream, and
 * the write that reads it fails with that error.
 */
export function guardedBody(
  source: ReadableStream<Uint8Array>,
  guard: BodyGuard,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let rejectStall!: (error: Error) => void;
  const stalled = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  stalled.catch(() => undefined);
  let stall: Error | undefined;
  const arm = () =>
    guard.clock.setTimer(guard.silenceMs, () => {
      stall = guard.onStalled();
      rejectStall(stall);
    });
  let timer = arm();
  const disarm = () => guard.clock.cancel(timer);

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let piece: ReadableStreamReadResult<Uint8Array>;
        try {
          piece = await Promise.race([reader.read(), stalled]);
        } catch (error: unknown) {
          disarm();
          void reader.cancel().catch(() => undefined);
          controller.error(error === stall ? error : new BodyCutError(error));
          return;
        }
        disarm();
        if (piece.done) {
          controller.close();
          return;
        }
        try {
          guard.onChunk(piece.value);
        } catch (error: unknown) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
          return;
        }
        timer = arm();
        controller.enqueue(piece.value);
      },
      cancel: (reason) => {
        disarm();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
