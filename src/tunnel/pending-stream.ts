import type { TcpStream } from "../ports/index.js";

// why: a caller announces a forwarded connection with OPEN and sends its bytes at once, before the device has answered, so the connection exists from the OPEN and its writes, its END and its close wait for the device connect, in the order they came.
export function pendingStream(connecting: Promise<TcpStream>): TcpStream {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return {
    close: () => {
      void connecting.then(
        (stream) => {
          stream.close();
        },
        () => undefined,
      );
    },
    end: () => {
      void connecting.then(
        (stream) => {
          stream.end();
        },
        () => undefined,
      );
    },
    readable: new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        reader ??= (await connecting).readable.getReader();
        const step = await reader.read();
        if (step.done) controller.close();
        else controller.enqueue(step.value);
      },
    }),
    write: async (bytes) => {
      await (await connecting).write(bytes);
    },
  };
}
