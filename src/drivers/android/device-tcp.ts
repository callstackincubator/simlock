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
const TUNNEL_PORT_FIRST = 47_000;
const TUNNEL_PORT_LAST = 47_999;

const ADB_TIMEOUT_MS = 10_000;
const MESSAGE_LIMIT = 200;
const CANNOT_REBIND = "cannot rebind existing socket";

export interface AndroidDeviceTcpOptions {
  readonly listeners: TcpListenerFactory;
  // why: a sweep acts on a device only once the driver proved it Simlock's own; an emulator on a recorded serial may answer as another's (#284).
  readonly isOwn: (device: VirtualDriverDevice | PhysicalDriverDevice) => Promise<boolean>;
  readonly warn: (message: string, detail: Record<string, unknown>) => void;
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

type RunAdb = AndroidDeviceTcpOptions["runAdb"];
type Warn = AndroidDeviceTcpOptions["warn"];
type Target = VirtualDriverDevice | PhysicalDriverDevice;

// why: a rule that cannot be removed is logged and the caller goes on; reclaim and start must not stop for it.
async function attempt(
  run: RunAdb,
  warn: Warn,
  device: Target,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await run(device, args, ADB_TIMEOUT_MS);
    if (result.code === 0) return result.stdout;
    warn("An adb tunnel cleanup call failed", { args, stderr: cut(result.stderr.trim()) });
  } catch (error) {
    warn("An adb tunnel cleanup call failed", {
      args,
      error: cut(error instanceof Error ? error.message : String(error)),
    });
  }
  return undefined;
}

function fields(output: string): string[][] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3);
}

// why: reclaim of a device proved its own leaves none of the lease's rules: every reverse rule of this serial, and this serial's forwards one by one, because `forward --remove-all` would end every device's on the server.
export async function removeDeviceRules(
  run: RunAdb,
  warn: Warn,
  device: Target,
  serial: string,
): Promise<void> {
  await attempt(run, warn, device, ["reverse", "--remove-all"]);
  const listed = await attempt(run, warn, device, ["forward", "--list"]);
  for (const [owner, local] of fields(listed ?? "")) {
    if (owner === serial && local !== undefined) {
      await attempt(run, warn, device, ["forward", "--remove", local]);
    }
  }
}

// why: at start only a rule into the loopback range the worker keeps for tunnels is Simlock's own; a holder's other rules stay.
async function removeTunnelRules(run: RunAdb, warn: Warn, device: Target): Promise<void> {
  const listed = await attempt(run, warn, device, ["reverse", "--list"]);
  for (const [, deviceSide, hostSide] of fields(listed ?? "")) {
    const port = /^tcp:(\d{1,5})$/.exec(hostSide ?? "")?.[1];
    if (port === undefined || deviceSide === undefined) continue;
    if (Number(port) < TUNNEL_PORT_FIRST || Number(port) > TUNNEL_PORT_LAST) continue;
    await attempt(run, warn, device, ["reverse", "--remove", deviceSide]);
  }
}

export function createAndroidDeviceTcp(options: AndroidDeviceTcpOptions): DeviceTcp {
  return {
    supports: () => true,
    async sweep(devices): Promise<void> {
      await Promise.all(
        devices.map(async (device) => {
          if (await options.isOwn(device)) {
            await removeTunnelRules(options.runAdb, options.warn, device);
          }
        }),
      );
    },
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
