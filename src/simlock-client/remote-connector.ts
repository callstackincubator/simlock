import {
  type Clock,
  type IpcConnection,
  type IpcConnector,
  NodeWebSocketClientConnector,
  SystemClock,
  type WebSocketClient,
  type WebSocketClientConnector,
} from "../ports/index.js";
import type { ConnectOptions } from "./client.js";
import { farmOrigin } from "./farm-url.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface RemoteSessionOptions {
  readonly token: string;
  readonly webSocket: WebSocketClientConnector;
  readonly clock: Clock;
}

export interface RemoteConnectInput {
  readonly url: string;
  readonly token?: string;
  readonly webSocket?: WebSocketClientConnector;
  readonly clock?: Clock;
}

// why: `connectSimlock` and `connectSimlockAdmin` choose remote by a URL alone (ADR 0081 §3) and share this one step from it to the client's connect options.
export function remoteConnectOptions(input: RemoteConnectInput): ConnectOptions {
  return {
    connector: new RemoteSessionConnector({
      clock: input.clock ?? new SystemClock(),
      token: input.token ?? "",
      webSocket: input.webSocket ?? new NodeWebSocketClientConnector(),
    }),
    endpoint: farmOrigin(input.url),
  };
}

// why: ADR 0081 §1: the session path carries the socket protocol's lines as text messages, so a remote caller's `endpoint` is a farm's origin and the connector opens its `/v1/session`.
export class RemoteSessionConnector implements IpcConnector {
  readonly #options: RemoteSessionOptions;

  constructor(options: RemoteSessionOptions) {
    this.#options = options;
  }

  async connect(origin: string): Promise<IpcConnection> {
    const socket = await this.#options.webSocket.connect(
      `${origin.replace(/^http/, "ws")}/v1/session`,
      {
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        headers: { authorization: `Bearer ${this.#options.token}` },
      },
    );
    return new SessionLines(socket);
  }
}

// why: the wire reads `\n`-ended chunks, so each text message gets its newline back, and a write holding several lines goes out as one message per line.
class SessionLines implements IpcConnection {
  readonly #socket: WebSocketClient;
  readonly #data = new Set<(chunk: string) => void>();
  readonly #closes = new Set<() => void>();
  readonly #errors = new Set<(error: Error) => void>();
  #closed = false;

  constructor(socket: WebSocketClient) {
    this.#socket = socket;
    socket.onMessage((bytes) => {
      const chunk = `${new TextDecoder().decode(bytes)}\n`;
      for (const listener of this.#data) listener(chunk);
    });
    socket.onClose(() => {
      this.#closed = true;
      for (const listener of this.#closes) listener();
    });
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
    this.#socket.close(1000, "");
  }
}
