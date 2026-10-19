export const KEY_SET_MAX_BYTES = 64 * 1024;

export interface KeySetResponse {
  readonly status: number;
  readonly body: string;
}

export interface KeySetFetcher {
  fetch(url: string, options: { readonly signal: AbortSignal }): Promise<KeySetResponse>;
}

export class NodeKeySetFetcher implements KeySetFetcher {
  async fetch(url: string, options: { readonly signal: AbortSignal }): Promise<KeySetResponse> {
    const response = await globalThis.fetch(url, { redirect: "manual", signal: options.signal });
    const body = await readCapped(response, options.signal);
    return { status: response.status, body };
  }
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > KEY_SET_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`Key set body is over ${String(KEY_SET_MAX_BYTES)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class FakeKeySetFetcher implements KeySetFetcher {
  readonly urls: string[] = [];
  readonly signals: AbortSignal[] = [];
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
    this.signals.push(options.signal);
    return this.#handler(options.signal);
  }
}
