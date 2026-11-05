import { DeviceTcpError, type DeviceReverse, type DeviceTcp } from "../../core/index.js";
import {
  FakeTcpPeer,
  type Clock,
  type ProcessRunner,
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

export function createIosDeviceTcp(_options: IosDeviceTcpOptions): DeviceTcp {
  return {
    connect: (): Promise<TcpStream> => Promise.resolve(new FakeTcpPeer().stream),
    reverse: (): Promise<DeviceReverse> =>
      Promise.reject(new DeviceTcpError("TUNNEL_FAILED", "not built")),
    supports: () => false,
    sweep: () => Promise.resolve(),
  };
}
