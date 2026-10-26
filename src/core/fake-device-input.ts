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

  onFailed(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
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

  constructor(private readonly config: InputScreenConfig) {}

  open(): Promise<FakeDeviceInput | UnavailableDeviceInput> {
    const input = new FakeDeviceInput(this.config);
    this.opened.push(input);
    return Promise.resolve(input);
  }
}
