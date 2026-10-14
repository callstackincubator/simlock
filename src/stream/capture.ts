import { spawn } from "node:child_process";
import { Readable } from "node:stream";

import { MetaFrameScanner, type CaptureMeta } from "./framing.js";

export interface CaptureOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  onLog?(line: string): void;
  onEnd?(): void;
  // why: how long a capture may stay silent before its stream is called dead; see DEFAULT_SILENCE_MS
  // for the default and why there is a bound at all.
  readonly silenceMs?: number;
}

export interface CapturedStream {
  readonly meta: CaptureMeta;
  readonly body: ReadableStream<Uint8Array>;
  close(): void;
}

const LOG_TAIL = 20;

// why: a capture program that starts and never writes is the one failure a request cannot tell from a
// slow one, and an unbounded wait here would hold a viewer's connection, a worker's lease check and a
// simulator's framebuffer for a program that is never going to speak. Generous against a cold
// simulator; a bound rather than none because every other wait on another process has one.
const DEFAULT_SILENCE_MS = 30_000;

export async function captureStream(options: CaptureOptions): Promise<CapturedStream> {
  // why: stdin stays open on purpose. The capture tool treats it as a liveness handle, so closing it
  // is the stop the tool was built for, and a daemon that is killed outright closes it by itself --
  // which is the only reason a capture cannot outlive a worker that was SIGKILLed.
  const child = spawn(options.command, [...options.args], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => undefined);

  const tail: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      tail.push(line);
      if (tail.length > LOG_TAIL) tail.shift();
      options.onLog?.(line);
    }
  });

  // why: closing stdin is the polite stop and a signal is the backstop, because a tool that ignored
  // its liveness handle would otherwise pin a simulator's framebuffer forever. The half second is
  // only the grace it gets to write its own last log line.
  const stopTool = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const deadline = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 500);
    deadline.unref();
  };

  // why: `onEnd` unregisters the capture from the registry of running ones, and it has to fire for a
  // tool that dies on its own as much as for a stop, or a lease would keep looking like it had a
  // picture running.
  const notifyEnd = once(() => options.onEnd?.());
  child.on("close", notifyEnd);
  const close = () => {
    stopTool();
    notifyEnd();
  };

  // why: a child that dies is reported into the stream, so a viewer watching a simulator that was
  // shut down mid-picture sees the stream fail rather than a frame that froze in place.
  const died = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(withLog(error.message, tail)));
    child.on("close", (code, signal) =>
      reject(
        withLog(
          signal !== null
            ? `the capture tool was killed by ${signal}`
            : `the capture tool exited with code ${String(code)}`,
          tail,
        ),
      ),
    );
  });
  died.catch(() => undefined);
  // why: a process the OS refused to spawn never fires `close`, so that one path reports by hand.
  child.once("error", notifyEnd);

  const reader = Readable.toWeb(child.stdout).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const scanner = new MetaFrameScanner();
  const buffered: Uint8Array[] = [];

  // why: a timeout races every read, before and after the first frame, because "started and then went
  // quiet" is something a capture program can do at any point. A wait bounded only before the first
  // frame would still leave a viewer watching a frozen picture forever once the tool falls silent --
  // and a picture nobody can tell from a live one is the failure this module exists to avoid.
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  let silence: ReturnType<typeof setTimeout> | undefined;
  const readFrame = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const settle = (settleWith: () => void) => {
        clearTimeout(silence);
        settleWith();
      };
      silence = setTimeout(
        () =>
          reject(withLog(`the capture tool wrote nothing for ${String(silenceMs)}ms`, tail)),
        silenceMs,
      );
      silence.unref();
      reader.read().then(
        (step) => settle(() => resolve(step)),
        (error) => settle(() => reject(error)),
      );
    });

  try {
    for (;;) {
      const step = await Promise.race([readFrame(), died]);
      if (step.done) {
        throw withLog("the capture tool ended before it wrote a frame", tail);
      }
      buffered.push(step.value);
      const found = scanner.push(step.value);
      if (found !== undefined) {
        // why: everything read so far goes back on the front in order. The meta frame is what the
        // response head was answered from but a decoder needs it in the body too, and the bytes that
        // arrived in the same read as it are the first frames of the stream -- re-emitting the whole
        // buffer is what keeps any of them from being dropped, and nothing here re-frames.
        return {
          body: followedBy(concat(buffered), readFrame, reader, close),
          close,
          meta: found.meta,
        };
      }
    }
  } catch (error) {
    clearTimeout(silence);
    close();
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

function followedBy(
  prefix: Uint8Array,
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  source: ReadableStreamDefaultReader<Uint8Array>,
  onClose: () => void,
): ReadableStream<Uint8Array> {
  let handed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!handed) {
        handed = true;
        controller.enqueue(prefix);
        return;
      }
      try {
        const step = await read();
        if (step.done) {
          onClose();
          controller.close();
        } else controller.enqueue(step.value);
      } catch (error) {
        // why: a read that failed is the capture's end as much as a clean close is -- a body that
        // errors while a registry still names its capture is a lease that looks like it is still
        // being filmed, and the tool behind it has no idea its viewer is gone.
        onClose();
        controller.error(error);
      }
    },
    // why: a body dropped without its request being aborted still ends the capture -- a stream nobody
    // is reading has no claim on a simulator's framebuffer.
    cancel: (reason) => {
      onClose();
      return source.cancel(reason);
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

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

function withLog(detail: string, tail: readonly string[]): Error {
  return new Error(
    `The screen capture produced no stream (${detail})` +
      (tail.length === 0 ? "" : `: ${tail[tail.length - 1]}`),
  );
}
