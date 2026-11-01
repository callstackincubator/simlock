import type { TcpStream } from "../ports/index.js";
import type { PhysicalDriverDevice, VirtualDriverDevice } from "./driver.js";

// why: the refusals a driver or the catalog can name; the tunnel module passes the code on to the holder.
export class DeviceTcpError extends Error {
  constructor(
    readonly code: "TUNNEL_PORT_IN_USE" | "TUNNEL_FAILED" | "TUNNEL_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "DeviceTcpError";
  }
}

// why: one wording for a lease whose device cannot take a tunnel, so the catalog's refusal and the tunnel module's read the same to the holder.
export function unsupportedTunnelMessage(platform: string, physical: boolean): string {
  let noun = `a ${platform} device`;
  if (platform === "ios") noun = physical ? "an iPhone" : "an iOS simulator";
  return `the lease is on ${noun}; tunnels need an Android emulator or phone`;
}

// why: one device port reversed to a loopback listener on the worker; every connection the device
// opens to that port arrives on `onConnection`, until `close` removes the rule and the listener.
export interface DeviceReverse {
  readonly hostPort: number;
  onConnection(listener: (stream: TcpStream) => void): void;
  close(): Promise<void>;
}

// why: the sweep treats a leased device differently from an idle one, and only the registry knows which is which.
export interface SweptDevice {
  readonly device: VirtualDriverDevice | PhysicalDriverDevice;
  readonly leased: boolean;
}

// why: an optional driver member beside `input`; a platform whose device cannot reach a worker port
// leaves it out, and the tunnel module learns that from its absence rather than from a platform name.
export interface DeviceTcp {
  supports(device: VirtualDriverDevice | PhysicalDriverDevice): boolean;
  // why: called once at daemon start, before any lease is served: removes the rules a stopped daemon's tunnels left on idle devices proved Simlock's own; a leased device's rules stay until its reclaim, and the ports they point to are kept from new tunnels.
  sweep(devices: readonly SweptDevice[]): Promise<void>;
  reverse(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    devicePort: number,
    signal: AbortSignal,
  ): Promise<DeviceReverse>;
  // why: one connection from the worker to a device port, through the host protocol with no `adb forward` rule; a port with nothing listening rejects with a `DeviceTcpError` whose message is the reason the holder's connection is reset.
  connect(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    devicePort: number,
    signal: AbortSignal,
  ): Promise<TcpStream>;
}
