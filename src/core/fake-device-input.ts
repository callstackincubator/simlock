import type {
  DeviceInput,
  DeviceInputFactory,
  InputMessage,
  InputScreenConfig,
  UnavailableDeviceInput,
} from "./input.js";

// why: a device input for tests: it records what reached it and plays the device's changes.
export class FakeDeviceInput implements DeviceInput {
  readonly sent: InputMessage[] = [];
  closes = 0;
  readonly #configListeners = new Set<(config: InputScreenConfig) => void>();
  readonly #failedListeners = new Set<(error: Error) => void>();
  #config: InputScreenConfig;

  constructor(config: InputScreenConfig) {
    this.#config = config;
  }

  send(message: InputMessage): void {
    this.sent.push(message);
  }

  onConfig(listener: (config: InputScreenConfig) => void): () => void {
    this.#configListeners.add(listener);
    listener(this.#config);
    return () => this.#configListeners.delete(listener);
  }

  onFailed(listener: (error: Error) => void): () => void {
    this.#failedListeners.add(listener);
    return () => this.#failedListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }

  fail(error: Error): void {
    for (const listener of this.#failedListeners) listener(error);
  }

  changeConfig(config: InputScreenConfig): void {
    this.#config = config;
    for (const listener of this.#configListeners) listener(config);
  }
}

// why: a driver's `input` member for tests: `opened` holds every device input it handed out, so a test
// can tell one shared device input from one per socket.
export class FakeInputFactory implements DeviceInputFactory {
  readonly opened: FakeDeviceInput[] = [];
  // why: a test sets this to make the next opens fail, as a controller that cannot start does.
  failWith: Error | undefined;
  opens = 0;

  constructor(private readonly config: InputScreenConfig) {}

  open(): Promise<FakeDeviceInput | UnavailableDeviceInput> {
    this.opens += 1;
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const input = new FakeDeviceInput(this.config);
    this.opened.push(input);
    return Promise.resolve(input);
  }
}
