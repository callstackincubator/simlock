import {
  DeviceTcpError,
  type DeviceReverse,
  type DeviceTcp,
  type PhysicalDriverDevice,
  type SweptDevice,
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
  readonly isOwn: (device: VirtualDriverDevice) => Promise<boolean>;
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

async function listenInRange(
  listeners: TcpListenerFactory,
  skip: ReadonlySet<number>,
): Promise<TcpListener> {
  for (let port = TUNNEL_PORT_FIRST; port <= TUNNEL_PORT_LAST; port += 1) {
    if (skip.has(port)) continue;
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

// why: at start only a rule into the loopback range the worker keeps for tunnels is Simlock's own; a holder's other rules are not read as such.
async function tunnelRules(
  run: RunAdb,
  warn: Warn,
  device: Target,
): Promise<{ readonly deviceSide: string; readonly port: number }[] | undefined> {
  const listed = await attempt(run, warn, device, ["reverse", "--list"]);
  if (listed === undefined) return undefined;
  const rules: { deviceSide: string; port: number }[] = [];
  for (const [, deviceSide, hostSide] of fields(listed)) {
    const port = Number(/^tcp:(\d{1,5})$/.exec(hostSide ?? "")?.[1]);
    if (deviceSide === undefined || port < TUNNEL_PORT_FIRST || port > TUNNEL_PORT_LAST) continue;
    rules.push({ deviceSide, port });
  }
  return rules;
}

// why: a loopback port the worker still owes a device: a listener whose rule is set or could not be removed, or a rule a leased device kept at start; the device's reclaim frees them.
interface HeldPort {
  readonly port: number;
  readonly listener?: TcpListener | undefined;
}

export interface AndroidDeviceTcp extends DeviceTcp {
  // why: called by the driver's reclaim of a device: an emulator's rules are gone, so every port held for it is free; a phone's rules are only read, and a port some rule on it still points to stays held.
  release(device: VirtualDriverDevice | PhysicalDriverDevice): Promise<void>;
}

export function createAndroidDeviceTcp(options: AndroidDeviceTcpOptions): AndroidDeviceTcp {
  const held = new Map<string, Set<HeldPort>>();
  const keep = (deviceId: string, entry: HeldPort): void => {
    const mine = held.get(deviceId) ?? new Set<HeldPort>();
    mine.add(entry);
    held.set(deviceId, mine);
  };
  const heldPorts = (): Set<number> =>
    new Set([...held.values()].flatMap((mine) => [...mine].map((entry) => entry.port)));
  return {
    supports: () => true,
    async release(device): Promise<void> {
      const mine = held.get(device.deviceId);
      if (mine === undefined) return;
      // why: Simlock removes no rule it did not set on a phone, so a port a rule there still points to stays reserved; a phone whose rules cannot be read keeps all its ports.
      const rules = device.physical ? await tunnelRules(options.runAdb, options.warn, device) : [];
      const pointed = new Set(rules?.map(({ port }) => port) ?? [...mine].map(({ port }) => port));
      const freed = [...mine].filter((entry) => !pointed.has(entry.port));
      for (const entry of freed) mine.delete(entry);
      if (mine.size === 0) held.delete(device.deviceId);
      await Promise.all(freed.map((entry) => entry.listener?.close()));
    },
    async sweep(devices: readonly SweptDevice[]): Promise<void> {
      await Promise.all(
        devices.map(async ({ device, leased }) => {
          // why: a phone is a person's device whose other rules Simlock cannot tell from its own, so the sweep only reads its rules and keeps the ports they point to from the next `reverse`.
          if (device.physical) {
            for (const { port } of (await tunnelRules(options.runAdb, options.warn, device)) ??
              []) {
              keep(device.deviceId, { port });
            }
            return;
          }
          if (!(await options.isOwn(device))) return;
          const rules = (await tunnelRules(options.runAdb, options.warn, device)) ?? [];
          for (const { deviceSide, port } of rules) {
            if (leased) keep(device.deviceId, { port });
            else {
              await attempt(options.runAdb, options.warn, device, [
                "reverse",
                "--remove",
                deviceSide,
              ]);
            }
          }
        }),
      );
    },
    async reverse(device, devicePort): Promise<DeviceReverse> {
      const listener = await listenInRange(options.listeners, heldPorts());
      const refuse = async (error: DeviceTcpError): Promise<never> => {
        await listener.close();
        throw error;
      };
      const named = `reverse ${String(devicePort)}`;
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
            `${named}: ${cut(error instanceof Error ? error.message : String(error))}`,
          ),
        );
      }
      if (result.code !== 0) {
        const message = result.stderr.trim();
        return await refuse(
          message.includes(CANNOT_REBIND)
            ? new DeviceTcpError(
                "TUNNEL_PORT_IN_USE",
                `${named}: the device port is already reversed; remove that rule first`,
              )
            : new DeviceTcpError("TUNNEL_FAILED", `${named}: ${cut(message)}`),
        );
      }
      const mine: HeldPort = { listener, port: listener.port };
      keep(device.deviceId, mine);
      // why: once the rule is being removed, or when its removal fails, a connection that still arrives is closed at once.
      let accept: ((stream: TcpStream) => void) | undefined;
      listener.onConnection((stream) => {
        if (accept === undefined) stream.close();
        else accept(stream);
      });
      return {
        close: async () => {
          accept = undefined;
          let failure: Error | undefined;
          try {
            const removed = await options.runAdb(
              device,
              ["reverse", "--remove", `tcp:${String(devicePort)}`],
              ADB_TIMEOUT_MS,
            );
            if (removed.code !== 0) failure = new Error(cut(removed.stderr.trim()));
          } catch (error) {
            failure = new Error(cut(error instanceof Error ? error.message : String(error)));
          }
          // why: a rule that is still set points at this port, so the listener stays reserved until the device's reclaim removes the rule.
          if (failure !== undefined) throw failure;
          held.get(device.deviceId)?.delete(mine);
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
