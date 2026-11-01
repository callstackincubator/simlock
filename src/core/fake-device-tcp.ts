import { FakeTcpPeer, type TcpStream } from "../ports/index.js";
import type { DeviceReverse, DeviceTcp, SweptDevice } from "./device-tcp.js";

class FakeReverse implements DeviceReverse {
  closed = false;
  readonly #listeners: ((stream: TcpStream) => void)[] = [];

  constructor(
    readonly hostPort: number,
    private readonly onClose: () => void,
    private readonly failure: () => Error | undefined,
    private readonly gate: () => Promise<void> | undefined,
  ) {}

  onConnection(listener: (stream: TcpStream) => void): void {
    this.#listeners.push(listener);
  }

  async close(): Promise<void> {
    await this.gate();
    const failure = this.failure();
    if (failure !== undefined) throw failure;
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
  // why: a test sets this to make every rule removal fail, as an adb that does not answer does.
  closeFailure: Error | undefined;
  // why: a test sets a device port's failure to make its `reverse` refuse, as adb does for a port already reversed.
  readonly failures = new Map<number, Error>();
  // why: every device port a `reverse` ever set, in order, so a test can tell a rule that arrived late from one that never came.
  readonly reverseLog: number[] = [];
  // why: a test sets this to hold every `reverse` until it settles, as an adb call that is slow to answer does.
  gate: Promise<void> | undefined;
  // why: a test sets this to hold every rule removal until it settles, as an adb call that is slow to answer does.
  closeGate: Promise<void> | undefined;
  // why: every device list a `sweep` was given, in order, so a test can tell what the daemon asked a platform's driver to sweep.
  readonly sweeps: (readonly SweptDevice[])[] = [];
  // why: a test sets this to hold every `sweep` until it settles, as an adb call that is slow to answer does.
  sweepGate: Promise<void> | undefined;
  readonly #reverses = new Map<number, FakeReverse>();
  #nextHostPort = 47_000;

  get reversed(): readonly number[] {
    return [...this.#reverses.keys()];
  }

  supports(): boolean {
    return true;
  }

  async sweep(devices: readonly SweptDevice[]): Promise<void> {
    this.sweeps.push(devices);
    await this.sweepGate;
  }

  async reverse(
    _device: unknown,
    devicePort: number,
    _signal?: AbortSignal,
  ): Promise<DeviceReverse> {
    await this.gate;
    const failure = this.failures.get(devicePort);
    if (failure !== undefined) throw failure;
    this.reverseLog.push(devicePort);
    const hostPort = this.#nextHostPort;
    this.#nextHostPort += 1;
    const reverse = new FakeReverse(
      hostPort,
      () => {
        this.#reverses.delete(devicePort);
      },
      () => this.closeFailure,
      () => this.closeGate,
    );
    this.#reverses.set(devicePort, reverse);
    return reverse;
  }

  connect(devicePort: number): FakeTcpPeer {
    const peer = new FakeTcpPeer();
    this.#reverses.get(devicePort)?.accept(peer.stream);
    return peer;
  }
}
