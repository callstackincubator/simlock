const nothing = (): void => undefined;

/** why: copies of one seed run together, and its deletion takes a turn of its own: it waits for every copy in flight, and a copy asked for after it began waits for it, so no copy is made from a folder being deleted (ADR 0090 §3). */
export class SeedTurns {
  readonly #copies = new Map<string, Set<Promise<void>>>();
  readonly #deletions = new Map<string, Promise<void>>();

  async copy<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
    for (
      let pending = this.#deletions.get(sourceId);
      pending !== undefined;
      pending = this.#deletions.get(sourceId)
    ) {
      await pending;
    }
    const copy = run();
    const ended = copy.then(nothing, nothing);
    const running = this.#copies.get(sourceId) ?? new Set<Promise<void>>();
    running.add(ended);
    this.#copies.set(sourceId, running);
    try {
      return await copy;
    } finally {
      running.delete(ended);
      if (running.size === 0 && this.#copies.get(sourceId) === running) {
        this.#copies.delete(sourceId);
      }
    }
  }

  async delete<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
    const before = this.#deletions.get(sourceId) ?? Promise.resolve();
    const turn = (async () => {
      await before;
      await Promise.all(this.#copies.get(sourceId) ?? []);
      return run();
    })();
    const ended = turn.then(nothing, nothing);
    this.#deletions.set(sourceId, ended);
    try {
      return await turn;
    } finally {
      if (this.#deletions.get(sourceId) === ended) this.#deletions.delete(sourceId);
    }
  }
}
