/**
 * why: an upload's body is read through this, so every limit is checked as the bytes arrive: a body
 * that breaks one errors the stream, and the write that reads it fails with that error.
 */
export function guardedBody(
  source: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const piece = await reader.read();
          if (piece.done) {
            controller.close();
            return;
          }
          onChunk(piece.value);
          controller.enqueue(piece.value);
        } catch (error: unknown) {
          void reader.cancel().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}
