import { FakeTcpPeer, type TcpStream } from "../ports/index.js";
import type { DeviceReverse, DeviceTcp } from "./device-tcp.js";

class FakeReverse implements DeviceReverse {
  closed = false;
  readonly #listeners: ((stream: TcpStream) => void)[] = [];

  constructor(
    readonly hostPort: number,
    private readonly onClose: () => void,
  ) {}

  onConnection(listener: (stream: TcpStream) => void): void {
    this.#listeners.push(listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onClose();
  }

  accept(stream: TcpStream): void {
    for (const listener of this.#listeners) listener(stream);
  }
}

// why: a driver's `deviceTcp` member for tests: `reversed` holds the device ports whose rule is set,
// and `connect` plays the device opening a connection to one of them.
export class FakeDeviceTcp implements DeviceTcp {
  readonly #reverses = new Map<number, FakeReverse>();
  #nextHostPort = 47_000;

  get reversed(): readonly number[] {
    return [...this.#reverses.keys()];
  }

  async reverse(
    _device: unknown,
    devicePort: number,
    _signal?: AbortSignal,
  ): Promise<DeviceReverse> {
    const hostPort = this.#nextHostPort;
    this.#nextHostPort += 1;
    const reverse = new FakeReverse(hostPort, () => {
      this.#reverses.delete(devicePort);
    });
    this.#reverses.set(devicePort, reverse);
    return reverse;
  }

  connect(devicePort: number): FakeTcpPeer {
    const peer = new FakeTcpPeer();
    this.#reverses.get(devicePort)?.accept(peer.stream);
    return peer;
  }
}
