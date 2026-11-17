type AdmittedHook = (requestId: string, replayed: boolean) => void;

/**
 * why: a `lease.cancel` that overtakes its own `lease.request` (still awaiting capabilities and the
 * lock) would answer `not-found` for a request about to queue. Per requester, this holds one promise
 * per request not yet admitted, and `settled` waits on them.
 */
export class UnadmittedRequests {
  readonly #byRequester = new Map<string, Set<Promise<void>>>();

  async track<T>(
    requesterId: string,
    run: (admittedHook: (next?: AdmittedHook) => AdmittedHook) => Promise<T>,
  ): Promise<T> {
    let admit!: () => void;
    const pending = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const set = this.#byRequester.get(requesterId) ?? new Set<Promise<void>>();
    set.add(pending);
    this.#byRequester.set(requesterId, set);
    try {
      return await run((next) => (requestId, replayed) => {
        admit();
        next?.(requestId, replayed);
      });
    } finally {
      admit();
      set.delete(pending);
      if (set.size === 0 && this.#byRequester.get(requesterId) === set) {
        this.#byRequester.delete(requesterId);
      }
    }
  }

  async settled(requesterId: string): Promise<void> {
    await Promise.all(this.#byRequester.get(requesterId) ?? []);
  }
}
