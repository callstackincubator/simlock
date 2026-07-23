/**
 * Serializes short state read/decide/commit sections.
 *
 * Callers must keep driver work and other long-running I/O outside `run`.
 */
export class SerializedDecision {
  #tail: Promise<void> = Promise.resolve();

  async run<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
