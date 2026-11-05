import {
  DeviceTcpError,
  type DeviceReverse,
  type DeviceTcp,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
} from "../../core/index.js";
import {
  type Clock,
  type TimerHandle,
  type LoopbackHost,
  type ProcessRunner,
  type TcpListener,
  type TcpListenerFactory,
  type TcpProbe,
  type TcpStream,
  type TcpStreamConnector,
} from "../../ports/index.js";

export interface IosDeviceTcpOptions {
  readonly clock: Clock;
  readonly connector: TcpStreamConnector;
  readonly listeners: TcpListenerFactory;
  readonly probe: TcpProbe;
  readonly runner: ProcessRunner;
}

type Target = VirtualDriverDevice | PhysicalDriverDevice;

const LOOKUP_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MESSAGE_LIMIT = 200;
const LOOPBACKS: readonly LoopbackHost[] = ["127.0.0.1", "::1"];

// why: a simulator's processes are the only ones whose environment names its UDID, so the udid is the lease's identity on the worker's loopback.
function udidOf(device: Target): string {
  const data = device.driverData;
  if (
    typeof data === "object" &&
    data !== null &&
    "udid" in data &&
    typeof data.udid === "string"
  ) {
    return data.udid;
  }
  throw new DeviceTcpError("TUNNEL_FAILED", `device ${device.deviceId} has no simulator UDID`);
}

interface Listener {
  readonly pid: number;
  readonly addresses: ReadonlySet<string>;
}

function cut(message: string): string {
  return message.length > MESSAGE_LIMIT ? message.slice(0, MESSAGE_LIMIT) : message;
}

// why: `lsof -Fpn` prints `p<pid>` then an `n<address>:<port>` per socket; `*` is every interface, `[::1]` and `127.0.0.1` the loopbacks, anything else is not reachable through a loopback connect.
function parseListeners(output: string): Listener[] | undefined {
  const listeners: { pid: number; addresses: Set<string> }[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line === "") continue;
    const field = line.slice(1);
    if (line.startsWith("p")) {
      listeners.push({ addresses: new Set(), pid: Number(field) });
    } else if (line.startsWith("n")) {
      const current = listeners.at(-1);
      if (current === undefined) return undefined;
      const address = field.slice(0, field.lastIndexOf(":"));
      current.addresses.add(address === "[::1]" ? "::1" : address);
    }
  }
  return listeners.length === 0 || listeners.some(({ pid }) => !Number.isInteger(pid))
    ? undefined
    : listeners;
}

export function createIosDeviceTcp(options: IosDeviceTcpOptions): DeviceTcp {
  const nothingListens = (port: number) =>
    new DeviceTcpError(
      "TUNNEL_FAILED",
      `nothing on the lease's simulator listens on port ${String(port)}`,
    );

  async function listenersOn(port: number): Promise<Listener[]> {
    const result = await options.runner.run(
      "lsof",
      ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fpn"],
      { timeoutMs: LOOKUP_TIMEOUT_MS },
    );
    if (result.code === 1 && result.stdout.trim() === "") return [];
    const parsed = result.code === 0 ? parseListeners(result.stdout) : undefined;
    if (parsed === undefined) {
      const reason = result.code === 0 ? "unparsable output" : result.stderr.trim().split("\n")[0];
      throw new DeviceTcpError(
        "TUNNEL_FAILED",
        `could not check the port's owner: ${cut(reason ?? "")}`,
      );
    }
    return parsed;
  }

  async function holdsUdid(pid: number, udid: string): Promise<boolean> {
    const result = await options.runner.run("ps", ["eww", "-p", String(pid)], {
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    return result.code === 0 && result.stdout.split(/\s+/).includes(`SIMULATOR_UDID=${udid}`);
  }

  // why: a loopback connect reaches the most specific bind, so an address is dialled only when no other process holds it more specifically than the lease's own.
  function dialAddresses(listeners: readonly Listener[], leasePids: ReadonlySet<number>) {
    const lease = listeners.filter(({ pid }) => leasePids.has(pid));
    const others = listeners.filter(({ pid }) => !leasePids.has(pid));
    return LOOPBACKS.filter(
      (host) =>
        lease.some(({ addresses }) => addresses.has(host)) ||
        (lease.some(({ addresses }) => addresses.has("*")) &&
          !others.some(({ addresses }) => addresses.has(host))),
    );
  }

  async function connectOwned(device: Target, devicePort: number): Promise<TcpStream> {
    const udid = udidOf(device);
    const listeners = await listenersOn(devicePort);
    const leasePids = new Set<number>();
    for (const { pid } of listeners) if (await holdsUdid(pid, udid)) leasePids.add(pid);
    for (const host of dialAddresses(listeners, leasePids)) {
      try {
        return await options.connector.connect(devicePort, CONNECT_TIMEOUT_MS, host);
      } catch {
        // why: the next loopback address may still answer; when none does the holder is told nothing listens.
      }
    }
    throw nothingListens(devicePort);
  }

  return {
    // why: the owner check and the connect share one 5 s limit, counted from the caller's `OPEN`; a stream that opens after it is closed.
    async connect(device, devicePort): Promise<TcpStream> {
      let timer: TimerHandle | undefined;
      let timedOut = false;
      const limit = new Promise<never>((_, reject) => {
        timer = options.clock.setTimer(CONNECT_TIMEOUT_MS, () => {
          timedOut = true;
          reject(new DeviceTcpError("TUNNEL_FAILED", "timeout"));
        });
      });
      const opening = connectOwned(device, devicePort);
      void opening.then(
        (stream) => {
          if (timedOut) stream.close();
        },
        () => undefined,
      );
      try {
        return await Promise.race([opening, limit]);
      } finally {
        if (timer !== undefined) options.clock.cancel(timer);
      }
    },
    // why: an app in a simulator tries `::1` before `127.0.0.1`, so the worker listens on the device port itself on both; a port that anything already answers on is refused, because a wildcard holder would leave the bind to succeed on a more specific address nobody dials.
    async reverse(_device, devicePort): Promise<DeviceReverse> {
      const named = `reverse ${String(devicePort)}`;
      const inUse = new DeviceTcpError(
        "TUNNEL_PORT_IN_USE",
        `${named}: port ${String(devicePort)} is already in use on the worker; pick another port`,
      );
      for (const host of LOOPBACKS) {
        if (await options.probe.isListening(devicePort, undefined, host)) throw inUse;
      }
      const bound: TcpListener[] = [];
      try {
        for (const host of LOOPBACKS) {
          const listener = await options.listeners.listen(devicePort, host);
          if (listener === undefined) throw inUse;
          bound.push(listener);
        }
      } catch (error) {
        await Promise.all(bound.map((listener) => listener.close()));
        if (error instanceof DeviceTcpError) throw error;
        throw new DeviceTcpError(
          "TUNNEL_FAILED",
          `${named}: ${cut(error instanceof Error ? error.message : String(error))}`,
        );
      }
      // why: a connection that arrives before the tunnel has a handler, or after it is closing, is closed at once.
      let accept: ((stream: TcpStream) => void) | undefined;
      for (const listener of bound) {
        listener.onConnection((stream) => {
          if (accept === undefined) stream.close();
          else accept(stream);
        });
      }
      return {
        close: async () => {
          accept = undefined;
          await Promise.all(bound.map((listener) => listener.close()));
        },
        hostPort: devicePort,
        onConnection: (handler) => {
          accept = handler;
        },
      };
    },
    supports: (device) => !device.physical,
    sweep: () => Promise.resolve(),
  };
}
