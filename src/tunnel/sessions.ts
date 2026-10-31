import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_MIN_DEVICE_PORT,
  TUNNEL_REFUSED_CLOSE,
  TUNNEL_TAG,
} from "../contract/index.js";
import { toDriverDevice, type DeviceRecord } from "../core/index.js";
import type { ModuleDeviceTcp } from "../modules/index.js";
import type { LeaseSocket, TcpStream } from "../ports/index.js";

interface Tunnel {
  readonly kind: "reverse" | "forward";
  readonly devicePort: number;
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

    async function pump(conn: number, stream: TcpStream): Promise<void> {
      const reader = stream.readable.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) return;
        socket.send(encodeTunnelFrame(TUNNEL_TAG.data, conn, step.value));
      }
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
          void pump(conn, stream);
        });
      }
      socket.send(encodeTunnelFrame(TUNNEL_TAG.ready, 0, JSON.stringify({ tunnels })));
    }

    socket.onMessage((data) => {
      const frame = decodeTunnelFrame(data);
      if (frame?.tag === TUNNEL_TAG.hello) void hello(frame.payload);
    });
  }

  return { attach };
}
