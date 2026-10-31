import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  ERROR_TABLE,
  type SimlockErrorCode,
  TUNNEL_MAX_DATA_BYTES,
  TUNNEL_MAX_DEVICE_PORT,
  TUNNEL_MAX_TUNNELS,
  TUNNEL_TAG,
  TUNNEL_WINDOW_BYTES,
} from "../../contract/index.js";
import {
  type TcpListener,
  type TcpStream,
  type TimerHandle,
  type WebSocketClient,
  WebSocketRefusedError,
} from "../../ports/index.js";
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

interface TunnelSpec {
  readonly kind: "reverse" | "forward";
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

function parseTunnel(words: readonly string[], index: number): TunnelSpec {
  const kind = words[index] as string;
  if (kind !== "reverse" && kind !== "forward") {
    throw new UsageError(`Unknown tunnel kind "${kind}": use reverse or forward`);
  }
  const text = words[index + 1] ?? "";
  const colon = text.indexOf(":");
  const device = colon === -1 ? text : text.slice(0, colon);
  const devicePort = portOf(device, "device");
  return {
    callerPort: portOf(colon === -1 ? device : text.slice(colon + 1), "caller"),
    devicePort,
    kind,
  };
}

function parseTunnels(words: readonly string[]): readonly TunnelSpec[] {
  if (words.length === 0) {
    throw new UsageError("Name at least one tunnel: reverse|forward <device-port>[:<caller-port>]");
  }
  const specs: TunnelSpec[] = [];
  for (let index = 0; index < words.length; index += 2) specs.push(parseTunnel(words, index));
  if (specs.length > TUNNEL_MAX_TUNNELS)
    throw new UsageError(`At most ${String(TUNNEL_MAX_TUNNELS)} tunnels`);
  const callerPorts = specs.map(({ callerPort }) => callerPort);
  const repeated = callerPorts.find((port, at) => callerPorts.indexOf(port) !== at);
  if (repeated !== undefined) {
    throw new UsageError(`Caller port ${String(repeated)} is named by two tunnels`);
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
  const adopt = (conn: number, stream: TcpStream): void => {
    const relayed: Relayed = {
      stream,
      wake: undefined,
      window: TUNNEL_WINDOW_BYTES,
      writes: Promise.resolve(),
    };
    streams.set(conn, relayed);
    void pump(conn, relayed);
  };
  const openConnection = async (spec: TunnelSpec, conn: number): Promise<void> => {
    let stream: TcpStream;
    try {
      stream = await environment.tcpStreams.connect(spec.callerPort, CALLER_CONNECT_TIMEOUT_MS);
    } catch {
      warn(spec.devicePort, spec.callerPort);
      socket.send(encodeTunnelFrame(TUNNEL_TAG.reset, conn));
      return;
    }
    adopt(conn, stream);
  };
  const onFrame = (
    connection: Relayed,
    frame: { tag: number; conn: number; payload: Uint8Array },
  ): void => {
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
  const relay = async (
    spec: TunnelSpec | undefined,
    frame: { tag: number; conn: number; payload: Uint8Array },
  ): Promise<void> => {
    if (frame.tag === TUNNEL_TAG.open) {
      if (spec !== undefined) await openConnection(spec, frame.conn);
      return;
    }
    const connection = streams.get(frame.conn);
    if (connection !== undefined) onFrame(connection, frame);
  };
  return { adopt, relay };
}

const HELLO_TIMEOUT_MS = 90_000;
const SILENCE_TIMEOUT_MS = 45_000;
const CLOSE_WAIT_MS = 2_000;
const CLOSE_LEASE_ENDED = 4001;

// why: a failure here carries the worker's own code, which can be one the contract's table does not hold (an HTTP 401 answers `UNAUTHENTICATED`), so the command prints its one JSON line itself.
class TunnelFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function disconnected(message: string): TunnelFailure {
  return new TunnelFailure("TUNNEL_DISCONNECTED", message, 1);
}

function bodyError(body: unknown): { code: string; message: string } | undefined {
  const error = field(body, "error");
  const code = field(error, "code");
  const message = field(error, "message");
  return typeof code === "string" && typeof message === "string" ? { code, message } : undefined;
}

function refusedTo(status: number, text: string, leaseId: string): TunnelFailure {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const answered = bodyError(body);
  if (answered !== undefined) {
    return new TunnelFailure(
      answered.code,
      answered.message,
      answered.code in ERROR_TABLE ? ERROR_TABLE[answered.code as SimlockErrorCode].cliExitCode : 1,
    );
  }
  return status === 404
    ? new TunnelFailure("UNKNOWN_LEASE", `Lease ${leaseId} is not known to this worker`, 1)
    : disconnected(`Lease ${leaseId}: the worker answered ${String(status)}`);
}

async function lookup(environment: CliEnvironment, url: string, token: string) {
  let answer: Awaited<ReturnType<CliEnvironment["httpJson"]["get"]>>;
  try {
    answer = await environment.httpJson.get(url, token);
  } catch {
    throw disconnected(`No answer from ${new URL(url).origin}`);
  }
  if (answer.status < 200 || answer.status > 299) {
    const failed = bodyError(answer.body);
    throw new TunnelFailure(
      failed?.code ?? "TUNNEL_DISCONNECTED",
      failed?.message ?? `The worker answered ${String(answer.status)}`,
      1,
    );
  }
  return answer;
}

async function leaseToUse(
  environment: CliEnvironment,
  base: string,
  token: string,
  lease: string | undefined,
): Promise<string> {
  if (lease !== undefined) return lease;
  const identity = await lookup(environment, `${base}/v1/identity`, token);
  const leases = await lookup(environment, `${base}/v1/leases`, token);
  return selectOnlyLease(
    (field(leases.body, "leases") as { id: string; requesterId: string }[] | undefined) ?? [],
    field(identity.body, "role") === "admin" ? "admin" : "agent",
  );
}

async function openSocket(
  environment: CliEnvironment,
  base: string,
  secret: string,
  leaseId: string,
): Promise<WebSocketClient> {
  try {
    return await environment.webSocket.connect(
      `${base.replace(/^http/, "ws")}/v1/leases/${encodeURIComponent(leaseId)}/tunnel`,
      {
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        headers: { authorization: `Bearer ${secret}` },
      },
    );
  } catch (error) {
    if (error instanceof WebSocketRefusedError) throw refusedTo(error.status, error.body, leaseId);
    throw disconnected(`Lease ${leaseId}: no connection to the worker`);
  }
}

function frameFailure(frame: { payload: Uint8Array }, leaseId: string): TunnelFailure {
  const refusal: unknown = JSON.parse(new TextDecoder().decode(frame.payload));
  const code = field(refusal, "code");
  const known =
    typeof code === "string" && code in ERROR_TABLE ? (code as SimlockErrorCode) : "TUNNEL_FAILED";
  return new TunnelFailure(
    known,
    `Lease ${leaseId}: ${String(field(refusal, "message"))}`,
    ERROR_TABLE[known].cliExitCode,
  );
}

function serve(
  environment: CliEnvironment,
  socket: WebSocketClient,
  specs: readonly TunnelSpec[],
  listeners: ReadonlyMap<TunnelSpec, TcpListener>,
  leaseId: string,
): Promise<number> {
  const warned = new Map<number, number>();
  const { adopt, relay } = relayConnections(socket, environment, (devicePort, callerPort) => {
    const now = environment.clock.now();
    const last = warned.get(devicePort);
    if (last !== undefined && now - last < WARN_EVERY_MS) return;
    warned.set(devicePort, now);
    environment.stderr.write(
      `reverse ${String(devicePort)}: nothing listening on localhost:${String(callerPort)}\n`,
    );
  });
  let nextCallerConnection = 2;
  for (const [spec, listener] of listeners) {
    listener.onConnection((stream) => {
      const conn = nextCallerConnection;
      nextCallerConnection += 2;
      socket.send(
        encodeTunnelFrame(
          TUNNEL_TAG.open,
          conn,
          JSON.stringify({ devicePort: spec.devicePort, kind: "forward" }),
        ),
      );
      adopt(conn, stream);
    });
  }
  // why: an OPEN waits for its loopback connect, and the DATA behind it must not overtake it, so frames are handled one at a time.
  let handled = Promise.resolve();
  return new Promise<number>((resolve, reject) => {
    let silence: TimerHandle | undefined;
    let finished = false;
    let stopping = false;
    const helloTimer = environment.clock.setTimer(HELLO_TIMEOUT_MS, () => {
      end(disconnected(`Lease ${leaseId}: no READY from the worker within 90 s`));
    });
    const heard = () => {
      if (silence !== undefined) environment.clock.cancel(silence);
      silence = environment.clock.setTimer(SILENCE_TIMEOUT_MS, () => {
        end(disconnected(`Lease ${leaseId}: nothing was heard from the worker for 45 s`));
      });
    };
    function end(failure: TunnelFailure | undefined): void {
      if (finished) return;
      finished = true;
      environment.signals.off("SIGINT", stop);
      environment.signals.off("SIGTERM", stop);
      environment.clock.cancel(helloTimer);
      if (silence !== undefined) environment.clock.cancel(silence);
      if (failure === undefined) resolve(0);
      else reject(failure);
    }
    function stop(): void {
      if (finished) return;
      stopping = true;
      environment.clock.setTimer(CLOSE_WAIT_MS, () => end(undefined));
      socket.close(CLOSE_NORMAL, "");
    }
    environment.signals.on("SIGINT", stop);
    environment.signals.on("SIGTERM", stop);
    heard();
    socket.onPing(heard);
    socket.onClose((code, reason) => {
      if (stopping) {
        end(undefined);
        return;
      }
      end(
        code === CLOSE_LEASE_ENDED
          ? new TunnelFailure(
              "TUNNEL_LEASE_ENDED",
              `Lease ${leaseId} ended: ${reason}`,
              ERROR_TABLE.TUNNEL_LEASE_ENDED.cliExitCode,
            )
          : disconnected(`Lease ${leaseId}: the connection to the worker was lost`),
      );
    });
    socket.onMessage((bytes) => {
      heard();
      const frame = decodeTunnelFrame(bytes);
      if (frame === undefined) return;
      if (frame.tag === TUNNEL_TAG.refused) {
        end(frameFailure(frame, leaseId));
        return;
      }
      if (frame.tag === TUNNEL_TAG.ready) {
        environment.clock.cancel(helloTimer);
        for (const { callerPort, devicePort, kind } of specs) {
          const route =
            kind === "reverse"
              ? `reverse device:${String(devicePort)} -> localhost:${String(callerPort)}`
              : `forward localhost:${String(callerPort)} -> device:${String(devicePort)}`;
          environment.stdout.write(`${route} (lease ${leaseId})\n`);
        }
        return;
      }
      const opened =
        frame.tag === TUNNEL_TAG.open
          ? specs.find(
              ({ devicePort, kind }) =>
                kind === "reverse" &&
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
          tunnels: specs.map(({ devicePort, kind }) => ({ devicePort, kind })),
        }),
      ),
    );
  });
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
      "Usage: simlock tunnel reverse|forward <device-port>[:<caller-port>] [reverse|forward ...] [--lease <id>] [--url <url>]\n",
    );
    return 0;
  }
  const specs = parseTunnels(positionals);
  const base = checkedUrl(typeof url === "string" ? url : environment.tunnelUrl);
  const secret = checkedToken(token ?? environment.tunnelToken);
  const listeners = new Map<TunnelSpec, TcpListener>();
  try {
    for (const spec of specs) {
      if (spec.kind !== "forward") continue;
      const listener = await environment.tcpListeners.listen(spec.callerPort);
      if (listener === undefined) {
        throw new TunnelFailure(
          "TUNNEL_CALLER_PORT_IN_USE",
          `forward ${String(spec.devicePort)}: localhost:${String(spec.callerPort)} is already in use`,
          ERROR_TABLE.TUNNEL_CALLER_PORT_IN_USE.cliExitCode,
        );
      }
      listeners.set(spec, listener);
    }
    const leaseId = await leaseToUse(
      environment,
      base,
      secret,
      typeof lease === "string" ? lease : undefined,
    );
    const socket = await openSocket(environment, base, secret, leaseId);
    return await serve(environment, socket, specs, listeners, leaseId);
  } catch (error) {
    if (!(error instanceof TunnelFailure)) throw error;
    environment.stderr.write(
      `${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`,
    );
    return error.exitCode;
  } finally {
    await Promise.all([...listeners.values()].map((listener) => listener.close()));
  }
}

export { run };
