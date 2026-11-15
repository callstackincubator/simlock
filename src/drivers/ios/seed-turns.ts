/** why: clones of one seed, and the seed's deletion, take turns, so nuke never deletes a seed under a running clone. */
export class SeedTurns {
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #holds = new Map<string, Promise<void>>();

  async take<T>(udid: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(udid) ?? Promise.resolve();
    const turn = before.then(run, run);
    const settled = turn.catch(() => undefined);
    this.#locks.set(udid, settled);
    try {
      return await turn;
    } finally {
      if (this.#locks.get(udid) === settled) this.#locks.delete(udid);
    }
  }

  /**
   * why: a copy that outlived its limit leaves its turn at the limit but still runs, so a deletion
   * queued behind it also waits for the hold `hold` places there; another copy does not.
   */
  async takeToDelete(udid: string, remove: () => Promise<void>): Promise<void> {
    await this.take(udid, async () => {
      for (let held = this.#holds.get(udid); held !== undefined; held = this.#holds.get(udid)) {
        await held;
      }
      await remove();
    });
  }

  hold(udid: string, until: Promise<void>): void {
    const held = Promise.all([this.#holds.get(udid) ?? Promise.resolve(), until]).then(
      () => undefined,
    );
    this.#holds.set(udid, held);
    void held.then(() => {
      if (this.#holds.get(udid) === held) this.#holds.delete(udid);
    });
  }
}
