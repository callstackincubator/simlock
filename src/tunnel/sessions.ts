import { decodeTunnelFrame, encodeTunnelFrame, TUNNEL_TAG } from "../contract/index.js";
import { toDriverDevice, type DeviceRecord } from "../core/index.js";
import type { ModuleDeviceTcp } from "../modules/index.js";
import type { LeaseSocket, TcpStream } from "../ports/index.js";

interface Tunnel {
  readonly kind: "reverse";
  readonly devicePort: number;
}

export interface TunnelSessions {
  attach(device: DeviceRecord, socket: LeaseSocket): void;
}

export function createTunnelSessions(options: {
  readonly deviceTcp: ModuleDeviceTcp;
}): TunnelSessions {
  function attach(device: DeviceRecord, socket: LeaseSocket): void {
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
