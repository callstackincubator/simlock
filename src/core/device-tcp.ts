import type { TcpStream } from "../ports/index.js";
import type { PhysicalDriverDevice, VirtualDriverDevice } from "./driver.js";

// why: the two refusals a driver can name; the tunnel module passes the code on to the holder.
export class DeviceTcpError extends Error {
  constructor(
    readonly code: "TUNNEL_PORT_IN_USE" | "TUNNEL_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DeviceTcpError";
  }
}

// why: one device port reversed to a loopback listener on the worker; every connection the device
// opens to that port arrives on `onConnection`, until `close` removes the rule and the listener.
export interface DeviceReverse {
  readonly hostPort: number;
  onConnection(listener: (stream: TcpStream) => void): void;
  close(): Promise<void>;
}

// why: an optional driver member beside `input`; a platform whose device cannot reach a worker port
// leaves it out, and the tunnel module learns that from its absence rather than from a platform name.
export interface DeviceTcp {
  reverse(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    devicePort: number,
    signal: AbortSignal,
  ): Promise<DeviceReverse>;
}
