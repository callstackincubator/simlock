import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_TAG,
} from "../../contract/index.js";
import type { TcpStream, WebSocketClient } from "../../ports/index.js";
import { commandArgs } from "../args.js";
import { selectOnlyLease } from "../remote-lease.js";
import type { CommandContext } from "../tree.js";
import type { CliEnvironment } from "../types.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALLER_CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_NORMAL = 1000;

interface ReverseSpec {
  readonly devicePort: number;
  readonly callerPort: number;
}

function parseReverses(words: readonly string[]): readonly ReverseSpec[] {
  const specs: ReverseSpec[] = [];
  for (let index = 0; index < words.length; index += 2) {
    const [device = "", caller = device] = (words[index + 1] ?? "").split(":");
    specs.push({ callerPort: Number(caller), devicePort: Number(device) });
  }
  return specs;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

async function leaseToUse(
  environment: CliEnvironment,
  base: string,
  token: string,
  lease: string | undefined,
): Promise<string> {
  if (lease !== undefined) return lease;
  const identity = await environment.httpJson.get(`${base}/v1/identity`, token);
  const leases = await environment.httpJson.get(`${base}/v1/leases`, token);
  return selectOnlyLease(
    (field(leases.body, "leases") as { id: string; requesterId: string }[] | undefined) ?? [],
    field(identity.body, "role") === "admin" ? "admin" : "agent",
    environment,
  );
}

// why: one caller connection per device connection; the stream's writes are chained so bytes reach the caller's port in the order the worker sent them.
function relayConnections(socket: WebSocketClient, environment: CliEnvironment) {
  const streams = new Map<number, { stream: TcpStream; writes: Promise<void> }>();
  return async (
    spec: ReverseSpec | undefined,
    frame: { tag: number; conn: number; payload: Uint8Array },
  ): Promise<void> => {
    if (frame.tag === TUNNEL_TAG.open && spec !== undefined) {
      const stream = await environment.tcpStreams.connect(
        spec.callerPort,
        CALLER_CONNECT_TIMEOUT_MS,
      );
      streams.set(frame.conn, { stream, writes: Promise.resolve() });
      void (async () => {
        const reader = stream.readable.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          for (let at = 0; at < step.value.length; at += TUNNEL_MAX_DATA_BYTES) {
            socket.send(
              encodeTunnelFrame(
                TUNNEL_TAG.data,
                frame.conn,
                step.value.subarray(at, at + TUNNEL_MAX_DATA_BYTES),
              ),
            );
          }
        }
        socket.send(encodeTunnelFrame(TUNNEL_TAG.end, frame.conn));
      })();
      return;
    }
    const connection = streams.get(frame.conn);
    if (connection === undefined) return;
    if (frame.tag === TUNNEL_TAG.data) {
      connection.writes = connection.writes.then(() => connection.stream.write(frame.payload));
    } else if (frame.tag === TUNNEL_TAG.end) {
      connection.writes = connection.writes.then(() => connection.stream.end());
    } else if (frame.tag === TUNNEL_TAG.reset) {
      connection.stream.close();
      streams.delete(frame.conn);
    }
  };
}

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const { help, lease, positionals, url } = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    lease: { type: "string" },
    url: { type: "string" },
  });
  if (help) {
    environment.stdout.write(
      "Usage: simlock tunnel reverse <device-port>[:<caller-port>] [reverse ...] [--lease <id>] [--url <url>]\n",
    );
    return 0;
  }
  const specs = parseReverses(positionals);
  const base = String(url ?? environment.tunnelUrl).replace(/\/$/, "");
  const secret = String(token ?? environment.tunnelToken);
  const leaseId = await leaseToUse(
    environment,
    base,
    secret,
    typeof lease === "string" ? lease : undefined,
  );
  const socket = await environment.webSocket.connect(
    `${base.replace(/^http/, "ws")}/v1/leases/${encodeURIComponent(leaseId)}/tunnel`,
    {
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      headers: { authorization: `Bearer ${secret}` },
    },
  );
  const relay = relayConnections(socket, environment);
  // why: an OPEN waits for its loopback connect, and the DATA behind it must not overtake it, so frames are handled one at a time.
  let handled = Promise.resolve();
  return new Promise<number>((resolve) => {
    const stop = () => {
      environment.signals.off("SIGINT", stop);
      environment.signals.off("SIGTERM", stop);
      socket.close(CLOSE_NORMAL, "");
      resolve(0);
    };
    environment.signals.on("SIGINT", stop);
    environment.signals.on("SIGTERM", stop);
    socket.onMessage((bytes) => {
      const frame = decodeTunnelFrame(bytes);
      if (frame === undefined) return;
      if (frame.tag === TUNNEL_TAG.ready) {
        for (const { callerPort, devicePort } of specs) {
          environment.stdout.write(
            `reverse device:${String(devicePort)} -> localhost:${String(callerPort)} (lease ${leaseId})\n`,
          );
        }
        return;
      }
      const opened =
        frame.tag === TUNNEL_TAG.open
          ? specs.find(
              ({ devicePort }) =>
                field(JSON.parse(new TextDecoder().decode(frame.payload)), "devicePort") ===
                devicePort,
            )
          : undefined;
      handled = handled.then(() => relay(opened, frame)).catch(() => undefined);
    });
    socket.send(
      encodeTunnelFrame(
        TUNNEL_TAG.hello,
        0,
        JSON.stringify({
          tunnels: specs.map(({ devicePort }) => ({ devicePort, kind: "reverse" })),
        }),
      ),
    );
  });
}

export { run };
