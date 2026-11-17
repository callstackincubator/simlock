import {
  type Clock,
  type IpcConnection,
  type IpcConnector,
  type TimerHandle,
  NodeWebSocketClientConnector,
  SystemClock,
  type WebSocketClient,
  type WebSocketClientConnector,
  WebSocketRefusedError,
} from "../ports/index.js";
import { type AnySimlockError, SimlockError } from "../contract/index.js";
import type { ConnectOptions } from "./client.js";
import { MAX_WIRE_LINE_CHARS } from "./wire.js";
import { farmOrigin, farmTokenFits, farmUrlProblem } from "./farm-url.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
// why: ADR 0081 §4: the farm pings every 15 s, so a session that hears nothing for 45 s has lost its network without a close.
const SILENCE_TIMEOUT_MS = 45_000;
const CLOSE_NORMAL = 1000;
// why: the farm closes a session with this code when the token behind it was revoked.
const CLOSE_TOKEN_REVOKED = 4003;

interface RemoteSessionOptions {
  readonly token: string;
  readonly webSocket: WebSocketClientConnector;
  readonly clock: Clock;
}

export interface RemoteConnectInput {
  readonly url?: string;
  readonly token?: string;
  readonly webSocket?: WebSocketClientConnector;
  readonly clock?: Clock;
  readonly principal?: string;
  // why: the options of the local transport, which a URL replaces and so refuses to share a call with.
  readonly connection?: unknown;
  readonly endpoint?: string;
  readonly ipc?: unknown;
  readonly credential?: string;
}

// why: `connectSimlock` and `connectSimlockAdmin` choose remote by a URL alone (ADR 0081 §3) and share this one step from it to the client's connect options. It returns nothing when no URL is given, so the local transport goes on as before.
export function remoteConnectOptions(input: RemoteConnectInput): ConnectOptions | undefined {
  if (input.url === undefined) return undefined;
  if (
    input.connection !== undefined ||
    input.endpoint !== undefined ||
    input.ipc !== undefined ||
    input.credential !== undefined
  ) {
    throw new Error(
      "`url` cannot be combined with `connection`, `endpoint`, `ipc` or `credential`",
    );
  }
  const problem = farmUrlProblem(input.url);
  if (problem === "scheme") {
    throw new Error("`url` must be https://, or http:// only for 127.0.0.1, [::1] or localhost");
  }
  if (problem === "origin") {
    throw new Error("`url` must be the farm's origin only: no path, query or fragment");
  }
  if (input.token === undefined || !farmTokenFits(input.token)) {
    throw new Error("`token` must be 1 to 4096 characters when `url` is given");
  }
  return {
    connector: new RemoteSessionConnector({
      clock: input.clock ?? new SystemClock(),
      token: input.token,
      webSocket: input.webSocket ?? new NodeWebSocketClientConnector(),
    }),
    endpoint: farmOrigin(input.url),
    ...(input.principal === undefined ? {} : { principal: input.principal }),
  };
}

// why: ADR 0081 §1: the session path carries the socket protocol's lines as text messages, so a remote caller's `endpoint` is a farm's origin and the connector opens its `/v1/session`.
class RemoteSessionConnector implements IpcConnector {
  readonly #options: RemoteSessionOptions;

  constructor(options: RemoteSessionOptions) {
    this.#options = options;
  }

  async connect(origin: string): Promise<IpcConnection> {
    const { clock, token, webSocket } = this.#options;
    const url = `${origin.replace(/^http/, "ws")}/v1/session`;
    const socket = await new Promise<WebSocketClient>((resolve, reject) => {
      // why: `ws` bounds its own handshake, but a connector that never settles must not hold the caller, so the wait has its own bound on the clock.
      const timer = clock.setTimer(HANDSHAKE_TIMEOUT_MS, () =>
        reject(unreachable("The farm did not answer within 10 s")),
      );
      webSocket
        .connect(url, {
          handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
          headers: { authorization: `Bearer ${token}` },
          maxPayloadBytes: MAX_WIRE_LINE_CHARS,
        })
        .then(resolve, (error: unknown) => reject(refusalOf(error)))
        .finally(() => clock.cancel(timer));
    });
    return new SessionLines(socket, clock);
  }
}

function unreachable(message: string): SimlockError<"REMOTE_UNREACHABLE"> {
  return new SimlockError("REMOTE_UNREACHABLE", "transport", message, {});
}

// why: a refusal at the upgrade is an HTTP answer: 401 and 403 are the farm judging the token, while anything else (a 404 where the path is not served, a proxy's 502) or no answer at all means the farm was not reached.
function refusalOf(error: unknown): AnySimlockError {
  if (error instanceof WebSocketRefusedError && error.status === 401) {
    return new SimlockError("UNAUTHENTICATED", "protocol", "The farm refused the token", {});
  }
  if (error instanceof WebSocketRefusedError && error.status === 403) {
    return new SimlockError("FORBIDDEN", "protocol", "The farm does not allow this token", {});
  }
  return unreachable(
    error instanceof WebSocketRefusedError
      ? `The farm answered ${String(error.status)} at its session path`
      : `The farm could not be reached: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// why: the wire reads `\n`-ended chunks, so each text message gets its newline back, and a write holding several lines goes out as one message per line. The session ends once, for whichever reason comes first: the farm's close, a drop, or 45 s without its ping.
class SessionLines implements IpcConnection {
  readonly #socket: WebSocketClient;
  readonly #clock: Clock;
  readonly #data = new Set<(chunk: string) => void>();
  readonly #closes = new Set<() => void>();
  readonly #errors = new Set<(error: Error) => void>();
  #silence: TimerHandle | undefined;
  #closed = false;

  constructor(socket: WebSocketClient, clock: Clock) {
    this.#socket = socket;
    this.#clock = clock;
    socket.onMessage((bytes) => {
      const chunk = `${new TextDecoder().decode(bytes)}\n`;
      for (const listener of this.#data) listener(chunk);
    });
    socket.onPing(() => this.#listen());
    socket.onClose((code) => this.#end(code));
    this.#listen();
  }

  get closed(): boolean {
    return this.#closed;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  async write(contents: string): Promise<void> {
    for (const line of contents.split("\n")) {
      if (line !== "") this.#socket.sendText(line);
    }
  }

  async close(): Promise<void> {
    this.#socket.close(CLOSE_NORMAL, "");
  }

  #listen(): void {
    if (this.#silence !== undefined) this.#clock.cancel(this.#silence);
    this.#silence = this.#clock.setTimer(SILENCE_TIMEOUT_MS, () => {
      this.#end(undefined);
      // why: a farm that vanished never answers a close, and `ws` would keep the socket and the process alive for 30 s past the bound.
      this.#socket.terminate();
    });
  }

  #end(code: number | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#silence !== undefined) this.#clock.cancel(this.#silence);
    if (code === CLOSE_TOKEN_REVOKED) {
      const revoked = new SimlockError(
        "UNAUTHENTICATED",
        "protocol",
        "The farm ended the session: its token was revoked",
        {},
      );
      for (const listener of this.#errors) listener(revoked);
    }
    for (const listener of this.#closes) listener();
  }
}
