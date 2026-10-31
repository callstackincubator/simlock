import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_HELLO_MAX_BYTES,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_MIN_DEVICE_PORT,
  TUNNEL_REFUSED_CLOSE,
  TUNNEL_TAG,
  TUNNEL_WINDOW_BYTES,
  TUNNEL_WINDOW_LIMIT,
  type TunnelFrame,
} from "../contract/index.js";
import { toDriverDevice, type DeviceRecord } from "../core/index.js";
import type { ModuleDeviceTcp } from "../modules/index.js";
import type { LeaseSocket, TcpStream } from "../ports/index.js";

interface Tunnel {
  readonly kind: "reverse" | "forward";
  readonly devicePort: number;
}

interface Connection {
  readonly stream: TcpStream;
  // why: how many bytes the worker may still send before the caller grants more credit.
  window: number;
  // why: how many bytes the caller may still send before the worker grants more credit.
  inbound: number;
  closed: boolean;
  wake: (() => void) | undefined;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

// why: the HELLO is wire input from a holder, so its size and shape are checked before any of it is used; a string is what was wrong with it.
function parseHello(payload: Uint8Array): readonly Tunnel[] | string {
  if (payload.length > TUNNEL_HELLO_MAX_BYTES) {
    return `HELLO is longer than ${String(TUNNEL_HELLO_MAX_BYTES)} bytes`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return "HELLO is not valid JSON";
  }
  const named = field(parsed, "tunnels");
  if (!Array.isArray(named) || named.length === 0) return "HELLO must name 1 to 8 tunnels";
  const tunnels: Tunnel[] = [];
  for (const entry of named) {
    const kind = field(entry, "kind");
    const devicePort = field(entry, "devicePort");
    if (
      (kind !== "reverse" && kind !== "forward") ||
      typeof devicePort !== "number" ||
      !Number.isInteger(devicePort)
    ) {
      return "HELLO tunnels must each be {kind, devicePort}";
    }
    tunnels.push({ devicePort, kind });
  }
  return tunnels;
}

function refusal(tunnels: readonly Tunnel[], held: number): Refusal | undefined {
  if (held + tunnels.length > TUNNEL_MAX_TUNNELS) {
    return {
      code: "TUNNEL_LIMIT",
      message: `the lease already has ${String(held + tunnels.length)} tunnels; at most ${String(TUNNEL_MAX_TUNNELS)}`,
    };
  }
  for (const { devicePort, kind } of tunnels) {
    if (devicePort < TUNNEL_MIN_DEVICE_PORT || devicePort > TUNNEL_MAX_DEVICE_PORT) {
      return {
        code: "TUNNEL_BAD_PORT",
        message: `${kind} ${String(devicePort)}: device ports are ${String(TUNNEL_MIN_DEVICE_PORT)} to ${String(TUNNEL_MAX_DEVICE_PORT)}`,
      };
    }
  }
  if (tunnels.some(({ kind }) => kind === "forward")) {
    return { code: "TUNNEL_UNSUPPORTED", message: "forward tunnels are not available yet" };
  }
  return undefined;
}

export interface TunnelSessions {
  attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void;
}

export function createTunnelSessions(options: {
  readonly deviceTcp: ModuleDeviceTcp;
}): TunnelSessions {
  // why: the 8-tunnel limit counts every socket of one lease, so the count is the lease's, not the socket's.
  const counts = new Map<string, number>();

  function attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void {
    let nextConnection = 1;
    let greeted = false;
    const connections = new Map<number, Connection>();

    // why: a connection reads from its device stream only while the caller has granted window, so a slow reader stops its own connection and no other.
    async function pump(conn: number, connection: Connection): Promise<void> {
      const reader = connection.stream.readable.getReader();
      let pending: Uint8Array | undefined;
      for (;;) {
        while (connection.window === 0) {
          await new Promise<void>((wake) => {
            connection.wake = wake;
          });
          if (connection.closed) return;
        }
        if (pending === undefined) {
          const step = await reader.read();
          if (step.done) return;
          pending = step.value;
        }
        const size = Math.min(pending.length, connection.window, TUNNEL_MAX_DATA_BYTES);
        socket.send(encodeTunnelFrame(TUNNEL_TAG.data, conn, pending.subarray(0, size)));
        connection.window -= size;
        pending = size === pending.length ? undefined : pending.subarray(size);
      }
    }

    function refuse(refused: Refusal): void {
      socket.send(encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify(refused)));
      socket.close(TUNNEL_REFUSED_CLOSE, refused.message);
    }

    function badRequest(message: string): void {
      refuse({ code: "BAD_REQUEST", message });
    }

    async function received(
      conn: number,
      connection: Connection,
      payload: Uint8Array,
    ): Promise<void> {
      await connection.stream.write(payload);
      connection.inbound += payload.length;
      const granted = new Uint8Array(4);
      new DataView(granted.buffer).setUint32(0, payload.length);
      socket.send(encodeTunnelFrame(TUNNEL_TAG.credit, conn, granted));
    }

    async function hello(payload: Uint8Array): Promise<void> {
      const named = parseHello(payload);
      if (typeof named === "string") {
        badRequest(named);
        return;
      }
      const tunnels = named.map(({ devicePort, kind }) => ({ kind, devicePort }));
      const held = counts.get(leaseId) ?? 0;
      const refused = refusal(tunnels, held);
      if (refused !== undefined) {
        refuse(refused);
        return;
      }
      counts.set(leaseId, held + tunnels.length);
      for (const tunnel of tunnels) {
        const reverse = await options.deviceTcp.reverse(
          device.spec.platform,
          toDriverDevice(device),
          tunnel.devicePort,
          new AbortController().signal,
        );
        reverse.onConnection((stream) => {
          const conn = nextConnection;
          nextConnection += 2;
          socket.send(encodeTunnelFrame(TUNNEL_TAG.open, conn, JSON.stringify(tunnel)));
          const connection: Connection = {
            closed: false,
            inbound: TUNNEL_WINDOW_BYTES,
            stream,
            wake: undefined,
            window: TUNNEL_WINDOW_BYTES,
          };
          connections.set(conn, connection);
          void pump(conn, connection);
        });
      }
      socket.send(encodeTunnelFrame(TUNNEL_TAG.ready, 0, JSON.stringify({ tunnels })));
    }

    function onData(conn: number, connection: Connection, payload: Uint8Array): void {
      if (payload.length > connection.inbound) {
        badRequest("DATA is past the granted window");
        return;
      }
      connection.inbound -= payload.length;
      void received(conn, connection, payload);
    }

    function onCredit(connection: Connection, payload: Uint8Array): void {
      const granted = new DataView(payload.buffer, payload.byteOffset, payload.length).getUint32(0);
      if (connection.window + granted > TUNNEL_WINDOW_LIMIT) {
        badRequest(`the window is above ${String(TUNNEL_WINDOW_LIMIT)}`);
        return;
      }
      connection.window += granted;
      connection.wake?.();
    }

    function handle(frame: TunnelFrame): void {
      if (!greeted) {
        if (frame.tag !== TUNNEL_TAG.hello) {
          badRequest("a frame came before HELLO");
          return;
        }
        greeted = true;
        void hello(frame.payload);
        return;
      }
      if (frame.tag === TUNNEL_TAG.hello) {
        badRequest("HELLO came twice");
        return;
      }
      if (
        frame.tag !== TUNNEL_TAG.data &&
        frame.tag !== TUNNEL_TAG.credit &&
        frame.tag !== TUNNEL_TAG.reset
      ) {
        badRequest(`unknown frame tag ${String(frame.tag)}`);
        return;
      }
      // why: the worker opens odd ids, rising from 1, so an even id or one above the last it opened was never a connection; one it opened and closed is ignored.
      if (frame.conn % 2 === 0 || frame.conn > nextConnection - 2) {
        badRequest(`connection ${String(frame.conn)} was never opened`);
        return;
      }
      const connection = connections.get(frame.conn);
      if (connection === undefined) return;
      if (frame.tag === TUNNEL_TAG.data) onData(frame.conn, connection, frame.payload);
      else if (frame.tag === TUNNEL_TAG.credit) onCredit(connection, frame.payload);
      else {
        connection.closed = true;
        connection.stream.close();
        connection.wake?.();
        connections.delete(frame.conn);
      }
    }

    socket.onMessage((data) => {
      const frame = decodeTunnelFrame(data);
      if (frame === undefined) badRequest("a frame is shorter than its 5-byte header");
      else handle(frame);
    });
  }

  return { attach };
}
