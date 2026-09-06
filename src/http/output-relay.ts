/**
 * The three states one `device.exec` request's output can be in on the HTTP side, and the one
 * place that decides what a chunk does in each (ADR 0005 §19a/§19e).
 *
 * - **Starting.** The process is running but the SSE stream has not opened yet -- one turn of
 *   the event loop, no more. A chunk waits here, and is flushed in order the moment it does.
 * - **Streaming.** Every chunk goes straight to the wire. Nothing is kept.
 * - **Dropped.** The client disconnected. The command deliberately keeps running (ADR 0004
 *   §3's reasoning applied to a process: a half-applied `simctl install` killed by a dropped
 *   tunnel is worse than one nobody watched finish), so its output keeps arriving with nowhere
 *   to go -- for as long as `exec.timeoutMs` allows. It goes nowhere: retaining it would let
 *   any caller turn one disconnect into ten minutes of daemon memory, which is both the
 *   opposite of §19e's "streamed, never buffered" and a remote memory-exhaustion lever.
 *
 * A small class rather than three closure variables in the route, because "nothing is retained
 * after a disconnect" is a safety property and a property has to be testable: `bufferedCount`
 * is what lets a test assert it directly instead of inferring it from heap size.
 */
export interface RelayedChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

export class OutputRelay {
  readonly #buffered: RelayedChunk[] = [];
  #deliver: ((chunk: RelayedChunk) => Promise<void>) | undefined;
  #dropped = false;

  /** How many chunks are held right now. Only the starting window can be non-zero; a test
   * asserts on it, the route never reads it. */
  get bufferedCount(): number {
    return this.#buffered.length;
  }

  /**
   * Returns what the delivery returned: while the stream is open that is the promise for this
   * chunk's write, and a caller who awaits it (the process runner, through
   * `DispatchSession.onOutput`) stops the command until the client has taken it. That is the
   * whole backpressure story on this side -- a client that opens the stream and never reads
   * slows the command down instead of filling this process (ADR 0005 §19e).
   */
  push(chunk: RelayedChunk): void | Promise<void> {
    if (this.#dropped) return undefined;
    if (this.#deliver !== undefined) return this.#deliver(chunk);
    this.#buffered.push(chunk);
    return undefined;
  }

  /** The stream is open: flush what arrived before it was, in order, then write straight
   * through from here on. */
  attach(deliver: (chunk: RelayedChunk) => Promise<void>): void {
    if (this.#dropped) return;
    for (const chunk of this.#buffered) void deliver(chunk).catch(() => undefined);
    this.#buffered.length = 0;
    this.#deliver = deliver;
  }

  /** The client is gone, terminally: release what is held and keep nothing further. */
  drop(): void {
    this.#dropped = true;
    this.#deliver = undefined;
    this.#buffered.length = 0;
  }
}
