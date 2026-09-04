import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { Clock } from "../ports/index.js";

/** ~15s per the issue spec, so idle tunnels don't close the stream. */
const KEEPALIVE_MS = 15_000;

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
}

/**
 * One live feed. `subscribe` is called once per connection; it must invoke `send` for every
 * event to emit (in order) and `end` exactly once the stream should close after flushing
 * whatever `send` calls are already queued. The returned function unsubscribes.
 */
export interface SseSource {
  subscribe(send: (event: SseEvent) => void, end: () => void): () => void;
}

/**
 * Bridges an `SseSource` to a hono SSE response. Keepalive comments and the source's own
 * lifetime both go through the injected `Clock` -- no `stream.sleep` (real `setTimeout` under
 * the hood) and no bare timers. Client abort unsubscribes the source and cancels the timer.
 */
export function pipeSse(c: Context, clock: Clock, source: SseSource): Response {
  return streamSSE(c, async (stream) => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    // `resolveDone` is idempotent on its own (a second call is a no-op), so `finish` doesn't
    // need an `ended` guard -- and deliberately has none: a terminal event's `send` and its
    // `end()` call both happen synchronously in the same source callback (e.g. `lease_lost`),
    // so a guard flipped by `end()` before the queued write actually runs would silently drop
    // that last write. `stream.closed` (set by the runtime only once this callback returns and
    // `run()`'s `finally` closes it -- see hono's `streaming/sse.ts`) is the only signal writes
    // below check, and it can't go true until after `writeChain` has already been awaited.
    const finish = () => resolveDone();

    // Serializes writes: `send` can be invoked synchronously (an immediate current-state
    // event on subscribe) or later from an event-bus callback, and writes must land in order.
    let writeChain: Promise<void> = Promise.resolve();
    const send = (event: SseEvent) => {
      if (stream.closed) return;
      writeChain = writeChain.then(async () => {
        if (stream.closed) return;
        await stream.writeSSE({
          data: JSON.stringify(event.data),
          event: event.event,
          ...(event.id === undefined ? {} : { id: event.id }),
        });
      });
    };

    let keepaliveTimer = clock.setTimer(KEEPALIVE_MS, tickKeepalive);
    function tickKeepalive(): void {
      if (stream.closed) return;
      writeChain = writeChain.then(async () => {
        if (stream.closed) return;
        await stream.write(": keepalive\n\n");
      });
      keepaliveTimer = clock.setTimer(KEEPALIVE_MS, tickKeepalive);
    }

    stream.onAbort(() => finish());

    const unsubscribe = source.subscribe(send, finish);
    await done;
    clock.cancel(keepaliveTimer);
    await writeChain;
    unsubscribe();
  });
}
