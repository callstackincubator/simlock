import {
  DeviceTcpError,
  type DeviceReverse,
  type DeviceTcp,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
} from "../../core/index.js";
import type {
  ProcessResult,
  TcpListener,
  TcpListenerFactory,
  TcpStream,
} from "../../ports/index.js";

// why: the worker keeps these loopback ports for tunnels, so a rule into them is Simlock's own and a sweep may remove it.
export const TUNNEL_PORT_FIRST = 47_000;
export const TUNNEL_PORT_LAST = 47_999;

const ADB_TIMEOUT_MS = 10_000;
const MESSAGE_LIMIT = 200;
const CANNOT_REBIND = "cannot rebind existing socket";

export interface AndroidDeviceTcpOptions {
  readonly listeners: TcpListenerFactory;
  // why: the driver decides which adb server and environment a device's command runs on, and for a phone which check it passes first.
  readonly runAdb: (
    device: VirtualDriverDevice | PhysicalDriverDevice,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<ProcessResult>;
}

function cut(message: string): string {
  return message.length > MESSAGE_LIMIT ? message.slice(0, MESSAGE_LIMIT) : message;
}

async function listenInRange(listeners: TcpListenerFactory): Promise<TcpListener> {
  for (let port = TUNNEL_PORT_FIRST; port <= TUNNEL_PORT_LAST; port += 1) {
    const listener = await listeners.listen(port);
    if (listener !== undefined) return listener;
  }
  throw new DeviceTcpError("TUNNEL_FAILED", "no free tunnel port on the worker");
}

export function createAndroidDeviceTcp(options: AndroidDeviceTcpOptions): DeviceTcp {
  return {
    supports: () => true,
    async reverse(device, devicePort): Promise<DeviceReverse> {
      const listener = await listenInRange(options.listeners);
      const refuse = async (error: DeviceTcpError): Promise<never> => {
        await listener.close();
        throw error;
      };
      let result: ProcessResult;
      try {
        result = await options.runAdb(
          device,
          ["reverse", "--no-rebind", `tcp:${String(devicePort)}`, `tcp:${String(listener.port)}`],
          ADB_TIMEOUT_MS,
        );
      } catch (error) {
        return await refuse(
          new DeviceTcpError(
            "TUNNEL_FAILED",
            cut(error instanceof Error ? error.message : String(error)),
          ),
        );
      }
      if (result.code !== 0) {
        const message = result.stderr.trim();
        return await refuse(
          new DeviceTcpError(
            message.includes(CANNOT_REBIND) ? "TUNNEL_PORT_IN_USE" : "TUNNEL_FAILED",
            cut(message),
          ),
        );
      }
      // why: once the rule is being removed, or when its removal fails, a connection that still arrives is closed at once.
      let accept: ((stream: TcpStream) => void) | undefined;
      listener.onConnection((stream) => {
        if (accept === undefined) stream.close();
        else accept(stream);
      });
      return {
        close: async () => {
          accept = undefined;
          const removed = await options.runAdb(
            device,
            ["reverse", "--remove", `tcp:${String(devicePort)}`],
            ADB_TIMEOUT_MS,
          );
          if (removed.code !== 0) throw new Error(cut(removed.stderr.trim()));
          await listener.close();
        },
        hostPort: listener.port,
        onConnection: (handler) => {
          accept = handler;
        },
      };
    },
  };
}
