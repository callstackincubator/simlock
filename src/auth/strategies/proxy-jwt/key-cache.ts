import { createLocalJWKSet } from "jose";

import { type Clock, KEY_SET_MAX_BYTES, type KeySetFetcher } from "../../../ports/index.js";

export type KeySet = ReturnType<typeof createLocalJWKSet>;

const KEY_KEEP_MS = 10 * 60_000;
const KEY_FETCH_LIMIT_MS = 5_000;
const UNKNOWN_KEY_REFETCH_MS = 30_000;

export class KeysUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysUnavailableError";
  }
}

interface Held {
  readonly keySet: KeySet;
  readonly fetchedAt: number;
}

export class KeyCache {
  readonly #clock: Clock;
  readonly #fetcher: KeySetFetcher;
  readonly #url: string;
  #held: Held | undefined;
  #inFlight: Promise<Held> | undefined;

  constructor(options: {
    readonly clock: Clock;
    readonly fetcher: KeySetFetcher;
    readonly url: string;
  }) {
    this.#clock = options.clock;
    this.#fetcher = options.fetcher;
    this.#url = options.url;
  }

  async current(): Promise<KeySet> {
    const held = this.#held;
    if (held !== undefined && this.#clock.now() - held.fetchedAt < KEY_KEEP_MS) return held.keySet;
    this.#held = undefined;
    return (await this.#load()).keySet;
  }

  async refreshed(): Promise<KeySet | undefined> {
    const held = this.#held;
    if (held === undefined) return undefined;
    if (this.#clock.now() - held.fetchedAt < UNKNOWN_KEY_REFETCH_MS) return undefined;
    try {
      return (await this.#load()).keySet;
    } catch {
      return undefined;
    }
  }

  #load(): Promise<Held> {
    this.#inFlight ??= this.#fetch().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #fetch(): Promise<Held> {
    const controller = new AbortController();
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      timer = this.#clock.setTimer(KEY_FETCH_LIMIT_MS, () => {
        const error = new KeysUnavailableError("The key URL gave no answer within 5 s");
        controller.abort(error);
        reject(error);
      });
    });
    try {
      const response = await Promise.race([
        this.#fetcher.fetch(this.#url, { signal: controller.signal }),
        limit,
      ]);
      const held = { keySet: parseKeySet(response), fetchedAt: this.#clock.now() };
      this.#held = held;
      return held;
    } catch (error) {
      if (error instanceof KeysUnavailableError) throw error;
      throw new KeysUnavailableError(error instanceof Error ? error.message : "Key fetch failed");
    } finally {
      if (timer !== undefined) this.#clock.cancel(timer);
      limit.catch(() => undefined);
    }
  }
}

function parseKeySet(response: { readonly status: number; readonly body: string }): KeySet {
  if (response.status !== 200) {
    throw new KeysUnavailableError(`The key URL answered ${String(response.status)}`);
  }
  if (Buffer.byteLength(response.body) > KEY_SET_MAX_BYTES) {
    throw new KeysUnavailableError("The key URL's body is over 64 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new KeysUnavailableError("The key URL's body is not JSON");
  }
  try {
    return createLocalJWKSet(parsed as Parameters<typeof createLocalJWKSet>[0]);
  } catch {
    throw new KeysUnavailableError("The key URL's body is not a key set");
  }
}
