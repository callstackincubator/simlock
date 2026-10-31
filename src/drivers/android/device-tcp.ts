import { type ChunkReader, openDeviceSocket } from "./screen/index.js";
import {
  DeviceTcpError,
  type DeviceReverse,
  type DeviceTcp,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
} from "../../core/index.js";
import type {
  Clock,
  ProcessResult,
  TcpListener,
  TcpListenerFactory,
  TcpStream,
} from "../../ports/index.js";

// why: the worker keeps these loopback ports for tunnels, so a rule into them is Simlock's own and a sweep may remove it.
const TUNNEL_PORT_FIRST = 47_000;
const TUNNEL_PORT_LAST = 47_999;

const ADB_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MESSAGE_LIMIT = 200;
const CANNOT_REBIND = "cannot rebind existing socket";

export interface AndroidDeviceTcpOptions {
  readonly listeners: TcpListenerFactory;
  readonly clock: Clock;
  // why: the driver decides which adb server a device is reached through, and for a phone which check it passes first; a target without a connector cannot open a device port.
  readonly target:
    | ((device: VirtualDriverDevice | PhysicalDriverDevice) => Promise<DeviceSocketTarget>)
    | undefined;
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

interface DeviceSocketTarget {
  readonly serial: string;
  connect(timeoutMs: number): Promise<TcpStream>;
}

// why: `openDeviceSocket` read the adb reply through a reader that may already hold the first bytes of the device's answer, so the stream handed on reads through it.
function streamThrough(stream: TcpStream, reader: ChunkReader): TcpStream {
  return {
    close: () => {
      stream.close();
    },
    end: () => {
      stream.end();
    },
    readable: new ReadableStream<Uint8Array>({
      cancel: () => {
        stream.close();
      },
      pull: async (controller) => {
        const chunk = await reader.read();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
    write: (bytes) => stream.write(bytes),
  };
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
    // why: the host protocol reaches a device port through the target's adb server with no `adb forward` rule, so a worker that dies leaves nothing listening; both answers share one 5 s limit.
    async connect(device, devicePort, signal): Promise<TcpStream> {
      if (options.target === undefined) {
        throw new DeviceTcpError("TUNNEL_FAILED", "this driver has no adb connection to open");
      }
      const target = await options.target(device);
      const limit = new AbortController();
      let timedOut = false;
      const timer = options.clock.setTimer(CONNECT_TIMEOUT_MS, () => {
        timedOut = true;
        limit.abort();
      });
      const relay = () => limit.abort();
      signal.addEventListener("abort", relay, { once: true });
      try {
        const outcome = await openDeviceSocket({
          connect: (timeoutMs) => target.connect(timeoutMs),
          serial: target.serial,
          service: `tcp:${String(devicePort)}`,
          signal: limit.signal,
          timeoutMs: CONNECT_TIMEOUT_MS,
        });
        if (timedOut) {
          if (outcome.kind === "open") outcome.stream.close();
          throw new DeviceTcpError("TUNNEL_FAILED", "timeout");
        }
        if (outcome.kind === "open") return streamThrough(outcome.stream, outcome.reader);
        throw new DeviceTcpError(
          "TUNNEL_FAILED",
          cut(
            outcome.kind === "refused"
              ? outcome.reason
              : `adb cannot reach ${target.serial}: ${outcome.reason}`,
          ),
        );
      } catch (error) {
        if (timedOut && !(error instanceof DeviceTcpError)) {
          throw new DeviceTcpError("TUNNEL_FAILED", "timeout");
        }
        throw error;
      } finally {
        options.clock.cancel(timer);
        signal.removeEventListener("abort", relay);
      }
    },
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
