import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  ERROR_TABLE,
  SimlockError,
  type SimlockErrorCode,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_TAG,
  TUNNEL_WINDOW_BYTES,
} from "../../contract/index.js";
import type { TcpStream, WebSocketClient } from "../../ports/index.js";
import { commandArgs, UsageError } from "../args.js";
import { selectOnlyLease } from "../remote-lease.js";
import type { CommandContext } from "../tree.js";
import type { CliEnvironment } from "../types.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALLER_CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_NORMAL = 1000;
const WARN_EVERY_MS = 10_000;
const MAX_URL_CHARS = 2048;
const MAX_TOKEN_CHARS = 4096;

interface ReverseSpec {
  readonly devicePort: number;
  readonly callerPort: number;
}

function portOf(text: string, what: string): number {
  const port = /^\d+$/.test(text) ? Number(text) : 0;
  if (port < 1 || port > TUNNEL_MAX_DEVICE_PORT) {
    throw new UsageError(`${what} port "${text}" is not an integer from 1 to 65535`);
  }
  return port;
}

function parseReverses(words: readonly string[]): readonly ReverseSpec[] {
  if (words.length === 0) {
    throw new UsageError("Name at least one tunnel: reverse <device-port>[:<caller-port>]");
  }
  const specs: ReverseSpec[] = [];
  for (let index = 0; index < words.length; index += 2) {
    const kind = words[index] as string;
    if (kind !== "reverse") {
      throw new UsageError(`Unknown tunnel kind "${kind}": only reverse is available`);
    }
    const text = words[index + 1] ?? "";
    const colon = text.indexOf(":");
    const device = colon === -1 ? text : text.slice(0, colon);
    const devicePort = portOf(device, "device");
    specs.push({
      callerPort: portOf(colon === -1 ? device : text.slice(colon + 1), "caller"),
      devicePort,
    });
  }
  if (specs.length > TUNNEL_MAX_TUNNELS)
    throw new UsageError(`At most ${String(TUNNEL_MAX_TUNNELS)} tunnels`);
  const seen = new Set<number>();
  for (const { callerPort } of specs) {
    if (seen.has(callerPort)) {
      throw new UsageError(`Caller port ${String(callerPort)} is named by two tunnels`);
    }
    seen.add(callerPort);
  }
  return specs;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

function checkedUrl(text: string | undefined): string {
  if (text === undefined || text === "") {
    throw new UsageError("No worker URL: pass --url or set SIMLOCK_URL");
  }
  const refusal = new UsageError(
    "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost",
  );
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw refusal;
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!allowed || text.length > MAX_URL_CHARS) throw refusal;
  return text.replace(/\/$/, "");
}

function checkedToken(text: string | undefined): string {
  if (text === undefined || text === "" || text.length > MAX_TOKEN_CHARS) {
    throw new UsageError("No token: pass --token or set SIMLOCK_TOKEN");
  }
  return text;
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
  );
}

// why: one caller connection per device connection. The stream's writes are chained so bytes reach the caller's port in the order the worker sent them, and each write is followed by a CREDIT that returns its bytes to the worker's window; the caller's own bytes leave only while the worker's window for them has room.
function relayConnections(
  socket: WebSocketClient,
  environment: CliEnvironment,
  warn: (devicePort: number, callerPort: number) => void,
) {
  interface Relayed {
    readonly stream: TcpStream;
    writes: Promise<void>;
    window: number;
    wake: (() => void) | undefined;
  }
  const streams = new Map<number, Relayed>();
  const pump = async (conn: number, relayed: Relayed): Promise<void> => {
    const reader = relayed.stream.readable.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      for (let at = 0; at < step.value.length;) {
        const size = Math.min(TUNNEL_MAX_DATA_BYTES, step.value.length - at, relayed.window);
        if (size === 0) {
          await new Promise<void>((resume) => {
            relayed.wake = resume;
          });
          continue;
        }
        relayed.window -= size;
        socket.send(encodeTunnelFrame(TUNNEL_TAG.data, conn, step.value.subarray(at, at + size)));
        at += size;
      }
    }
    socket.send(encodeTunnelFrame(TUNNEL_TAG.end, conn));
  };
  const grant = (conn: number, size: number): void => {
    const credit = new Uint8Array(4);
    new DataView(credit.buffer).setUint32(0, size);
    socket.send(encodeTunnelFrame(TUNNEL_TAG.credit, conn, credit));
  };
  return async (
    spec: ReverseSpec | undefined,
    frame: { tag: number; conn: number; payload: Uint8Array },
  ): Promise<void> => {
    if (frame.tag === TUNNEL_TAG.open && spec !== undefined) {
      let stream: TcpStream;
      try {
        stream = await environment.tcpStreams.connect(spec.callerPort, CALLER_CONNECT_TIMEOUT_MS);
      } catch {
        warn(spec.devicePort, spec.callerPort);
        socket.send(encodeTunnelFrame(TUNNEL_TAG.reset, frame.conn));
        return;
      }
      const relayed: Relayed = {
        stream,
        wake: undefined,
        window: TUNNEL_WINDOW_BYTES,
        writes: Promise.resolve(),
      };
      streams.set(frame.conn, relayed);
      void pump(frame.conn, relayed);
      return;
    }
    const connection = streams.get(frame.conn);
    if (connection === undefined) return;
    if (frame.tag === TUNNEL_TAG.data) {
      connection.writes = connection.writes
        .then(() => connection.stream.write(frame.payload))
        .then(() => grant(frame.conn, frame.payload.length));
    } else if (frame.tag === TUNNEL_TAG.credit) {
      connection.window += new DataView(
        frame.payload.buffer,
        frame.payload.byteOffset,
        frame.payload.length,
      ).getUint32(0);
      connection.wake?.();
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
  const base = checkedUrl(typeof url === "string" ? url : environment.tunnelUrl);
  const secret = checkedToken(token ?? environment.tunnelToken);
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
  const warned = new Map<number, number>();
  const relay = relayConnections(socket, environment, (devicePort, callerPort) => {
    const now = environment.clock.now();
    const last = warned.get(devicePort);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    warned.set(devicePort, now);
    environment.stderr.write(
      `reverse ${String(devicePort)}: nothing listening on localhost:${String(callerPort)}\n`,
    );
  });
  // why: an OPEN waits for its loopback connect, and the DATA behind it must not overtake it, so frames are handled one at a time.
  let handled = Promise.resolve();
  return new Promise<number>((resolve, reject) => {
    const settle = () => {
      environment.signals.off("SIGINT", stop);
      environment.signals.off("SIGTERM", stop);
    };
    const stop = () => {
      settle();
      socket.close(CLOSE_NORMAL, "");
      resolve(0);
    };
    environment.signals.on("SIGINT", stop);
    environment.signals.on("SIGTERM", stop);
    socket.onMessage((bytes) => {
      const frame = decodeTunnelFrame(bytes);
      if (frame === undefined) return;
      if (frame.tag === TUNNEL_TAG.refused) {
        settle();
        const refusal: unknown = JSON.parse(new TextDecoder().decode(frame.payload));
        const code = field(refusal, "code");
        reject(
          new SimlockError(
            typeof code === "string" && code in ERROR_TABLE
              ? (code as SimlockErrorCode)
              : "TUNNEL_FAILED",
            "domain",
            `Lease ${leaseId}: ${String(field(refusal, "message"))}`,
            {} as never,
          ),
        );
        return;
      }
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
