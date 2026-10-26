import type { ModuleTwoWayPipe } from "../modules/index.js";
import type { Clock, LeaseSocket, TimerHandle } from "../ports/index.js";
import { CHANNEL_TAG, encodeFrame, readFrames } from "./framing.js";

const HEARTBEAT_MS = 5_000;

// why: a worker's input session talks to a gateway's client through a relay channel, and the session
// takes a `LeaseSocket` whichever door the client came in by; this is the channel's end of that port,
// a socket whose messages are frames of the channel.
export function channelSocket(pipe: ModuleTwoWayPipe, clock: Clock): LeaseSocket {
  const writer = pipe.writable.getWriter();
  const messageListeners: ((data: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;
  let beat: TimerHandle | undefined;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    if (beat !== undefined) clock.cancel(beat);
    for (const listener of closeListeners) listener();
  };
  const write = (frame: Uint8Array): void => {
    writes = writes.then(() => writer.write(frame)).catch(() => undefined);
  };
  // why: the gateway ends a relay whose worker direction is silent for 15 s, and a session with nothing to say still has to be seen alive.
  const heartbeat = (): void => {
    if (closed) return;
    write(encodeFrame(CHANNEL_TAG.heartbeat, new Uint8Array()));
    beat = clock.setTimer(HEARTBEAT_MS, heartbeat);
  };
  beat = clock.setTimer(HEARTBEAT_MS, heartbeat);
  void (async () => {
    for await (const frame of readFrames(pipe.readable)) {
      const message = new Uint8Array(1 + frame.payload.length);
      message[0] = frame.tag;
      message.set(frame.payload, 1);
      for (const listener of messageListeners) listener(message);
    }
    markClosed();
  })();
  pipe.signal.addEventListener("abort", markClosed, { once: true });
  return {
    close: (code, reason) => {
      write(
        encodeFrame(CHANNEL_TAG.close, new TextEncoder().encode(JSON.stringify({ code, reason }))),
      );
      writes = writes.then(() => writer.close()).catch(() => undefined);
      markClosed();
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    send: (data) => write(encodeFrame(data[0] ?? 0, data.subarray(1))),
  };
}
