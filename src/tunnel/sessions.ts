import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_MIN_DEVICE_PORT,
  TUNNEL_REFUSED_CLOSE,
  TUNNEL_TAG,
  TUNNEL_WINDOW_BYTES,
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
  wake: (() => void) | undefined;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface TunnelSessions {
  attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void;
}

export function createTunnelSessions(options: {
  readonly deviceTcp: ModuleDeviceTcp;
}): TunnelSessions {
  // why: the 8-tunnel limit counts every socket of one lease, so the count is the lease's, not the socket's.
  const counts = new Map<string, number>();

  function refusal(tunnels: readonly Tunnel[], held: number): Refusal | undefined {
    if (held + tunnels.length > TUNNEL_MAX_TUNNELS) {
      return {
        code: "TUNNEL_LIMIT",
        message: `the lease already has ${String(held + tunnels.length)} tunnels; at most ${String(TUNNEL_MAX_TUNNELS)}`,
      };
    }
    for (const { devicePort, kind } of tunnels) {
      if (
        !Number.isInteger(devicePort) ||
        devicePort < TUNNEL_MIN_DEVICE_PORT ||
        devicePort > TUNNEL_MAX_DEVICE_PORT
      ) {
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

  function attach(leaseId: string, device: DeviceRecord, socket: LeaseSocket): void {
    let nextConnection = 1;

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

    async function received(
      conn: number,
      connection: Connection,
      payload: Uint8Array,
    ): Promise<void> {
      await connection.stream.write(payload);
      const granted = new Uint8Array(4);
      new DataView(granted.buffer).setUint32(0, payload.length);
      socket.send(encodeTunnelFrame(TUNNEL_TAG.credit, conn, granted));
    }

    async function hello(payload: Uint8Array): Promise<void> {
      const named = JSON.parse(new TextDecoder().decode(payload)) as { tunnels: Tunnel[] };
      const tunnels = named.tunnels.map(({ devicePort, kind }) => ({ kind, devicePort }));
      const held = counts.get(leaseId) ?? 0;
      const refused = refusal(tunnels, held);
      if (refused !== undefined) {
        socket.send(encodeTunnelFrame(TUNNEL_TAG.refused, 0, JSON.stringify(refused)));
        socket.close(TUNNEL_REFUSED_CLOSE, refused.message);
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
          const connection: Connection = { stream, wake: undefined, window: TUNNEL_WINDOW_BYTES };
          connections.set(conn, connection);
          void pump(conn, connection);
        });
      }
      socket.send(encodeTunnelFrame(TUNNEL_TAG.ready, 0, JSON.stringify({ tunnels })));
    }

    socket.onMessage((data) => {
      const frame = decodeTunnelFrame(data);
      if (frame === undefined) return;
      if (frame.tag === TUNNEL_TAG.hello) void hello(frame.payload);
      const connection = connections.get(frame.conn);
      if (connection === undefined) return;
      if (frame.tag === TUNNEL_TAG.data) void received(frame.conn, connection, frame.payload);
      if (frame.tag === TUNNEL_TAG.credit) {
        connection.window += new DataView(
          frame.payload.buffer,
          frame.payload.byteOffset,
          frame.payload.length,
        ).getUint32(0);
        connection.wake?.();
      }
    });
  }

  return { attach };
}
