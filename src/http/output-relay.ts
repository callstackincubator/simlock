/**
 * The three states one `device.exec` request's output can be in on the HTTP side, and the one
 * place that decides what a chunk does in each (ADR 0005 §19a/§19e).
 *
 * - **Starting.** The process is running but the SSE stream has not opened yet. `relay.attach`
 *   only runs inside hono's `streamSSE` callback, which is not guaranteed to be the very next
 *   turn of the event loop, so a chunk arriving here backpressures exactly like a streaming
 *   one: `push` returns a promise that does not resolve until the stream opens and this
 *   chunk is actually flushed (or the request is dropped first). That is what keeps the
 *   window's *memory* bounded even though its *duration* is not -- the process runner pauses
 *   the child at the first unresolved delivery, so at most one chunk per stream (stdout,
 *   stderr) is ever held here at once, never an unbounded backlog from a fast producer.
 * - **Streaming.** Every chunk goes straight to the wire. Nothing is kept.
 * - **Dropped.** The client disconnected. The command deliberately keeps running (ADR 0004
 *   §3's reasoning applied to a process: a half-applied `simctl install` killed by a dropped
 *   tunnel is worse than one nobody watched finish), so its output keeps arriving with nowhere
 *   to go -- for as long as `exec.timeoutMs` allows. It goes nowhere: retaining it would let
 *   any caller turn one disconnect into ten minutes of daemon memory, which is both the
 *   opposite of §19e's "streamed, never buffered" and a remote memory-exhaustion lever. Any
 *   chunk already held from the starting window is released immediately too, resolving its
 *   caller rather than leaving it paused on a delivery that will never happen.
 *
 * A small class rather than three closure variables in the route, because "nothing is retained
 * after a disconnect" is a safety property and a property has to be testable: `bufferedCount`
 * is what lets a test assert it directly instead of inferring it from heap size.
 */
export interface RelayedChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

/** One chunk held during the starting window, with the resolver for the promise `push`
 * handed back to its caller -- settled once this chunk is actually flushed by `attach`, or
 * released early by `drop`. */
interface BufferedChunk {
  readonly chunk: RelayedChunk;
  readonly resolve: () => void;
}

export class OutputRelay {
  readonly #buffered: BufferedChunk[] = [];
  #deliver: ((chunk: RelayedChunk) => Promise<void>) | undefined;
  #dropped = false;

  /** How many chunks are held right now. Only the starting window can be non-zero, and (see
   * the class doc) never more than one per stream; a test asserts on it, the route never
   * reads it. */
  get bufferedCount(): number {
    return this.#buffered.length;
  }

  /**
   * Returns what the delivery returned: while the stream is open that is the promise for this
   * chunk's write, and a caller who awaits it (the process runner, through
   * `DispatchSession.onOutput`) stops the command until the client has taken it. That is the
   * whole backpressure story on this side -- a client that opens the stream and never reads
   * slows the command down instead of filling this process (ADR 0005 §19e). Before the stream
   * opens, the same promise stands in for "actually flushed" rather than "merely queued": a
   * chunk held here does not let this handle's caller race ahead assuming it is already out.
   */
  push(chunk: RelayedChunk): void | Promise<void> {
    if (this.#dropped) return undefined;
    if (this.#deliver !== undefined) return this.#deliver(chunk);
    return new Promise<void>((resolve) => {
      this.#buffered.push({ chunk, resolve });
    });
  }

  /** The stream is open: flush what arrived before it was, in order, resolving each one's
   * `push` promise as its write settles, then write straight through from here on. */
  attach(deliver: (chunk: RelayedChunk) => Promise<void>): void {
    if (this.#dropped) return;
    const queued = this.#buffered.splice(0);
    this.#deliver = deliver;
    for (const { chunk, resolve } of queued) {
      void deliver(chunk).then(resolve, resolve);
    }
  }

  /** The client is gone, terminally: release what is held and keep nothing further. Anything
   * still waiting on a starting-window delivery is resolved right away -- it has nowhere to
   * go, the same as a chunk arriving after this point, so its caller should not stay paused
   * waiting for a flush that is never coming. */
  drop(): void {
    this.#dropped = true;
    this.#deliver = undefined;
    const queued = this.#buffered.splice(0);
    for (const { resolve } of queued) resolve();
  }
}
