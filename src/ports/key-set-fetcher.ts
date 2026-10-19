export const KEY_SET_MAX_BYTES = 64 * 1024;

export interface KeySetResponse {
  readonly status: number;
  readonly body: string;
}

export interface KeySetFetcher {
  fetch(url: string, options: { readonly signal: AbortSignal }): Promise<KeySetResponse>;
}

export class NodeKeySetFetcher implements KeySetFetcher {
  async fetch(_url: string, _options: { readonly signal: AbortSignal }): Promise<KeySetResponse> {
    return { status: 0, body: "" };
  }
}

export class FakeKeySetFetcher implements KeySetFetcher {
  readonly urls: string[] = [];
  #handler: (signal: AbortSignal) => Promise<KeySetResponse> = () =>
    Promise.reject(new Error("FakeKeySetFetcher has no answer scripted"));

  answer(response: KeySetResponse): void {
    this.#handler = () => Promise.resolve(response);
  }

  fail(error: Error): void {
    this.#handler = () => Promise.reject(error);
  }

  hang(): void {
    this.#handler = (signal) =>
      new Promise<KeySetResponse>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
  }

  hold(): { release(response: KeySetResponse): void } {
    let release!: (response: KeySetResponse) => void;
    const held = new Promise<KeySetResponse>((resolve) => {
      release = resolve;
    });
    this.#handler = () => held;
    return { release };
  }

  fetch(url: string, options: { readonly signal: AbortSignal }): Promise<KeySetResponse> {
    this.urls.push(url);
    return this.#handler(options.signal);
  }
}
