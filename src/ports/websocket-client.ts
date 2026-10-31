import type { RawData, WebSocket as WsSocket } from "ws";

export interface WebSocketClientOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly handshakeTimeoutMs: number;
}

// why: `connect` rejects with this when the server answers the upgrade with a plain HTTP response, so a caller can read the refusal's status and JSON body, which Node's own WebSocket client hides.
export class WebSocketRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`The server refused the WebSocket upgrade with ${String(status)}`);
    this.name = "WebSocketRefusedError";
  }
}

export interface WebSocketClient {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(listener: (bytes: Uint8Array) => void): void;
  // why: a server's ping is the only sign of life on an idle socket, and `ws` answers it without telling the caller.
  onPing(listener: () => void): void;
  // why: a socket that dropped without a close frame reports 1006, as `ws` does.
  onClose(listener: (code: number, reason: string) => void): void;
}

export interface WebSocketClientConnector {
  connect(url: string, options: WebSocketClientOptions): Promise<WebSocketClient>;
}

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : new Uint8Array(data);
}

class NodeWebSocketClient implements WebSocketClient {
  readonly #socket: WsSocket;
  readonly #messages: ((bytes: Uint8Array) => void)[] = [];
  readonly #pings: (() => void)[] = [];
  readonly #closes: ((code: number, reason: string) => void)[] = [];
  #closed: { readonly code: number; readonly reason: string } | undefined;

  constructor(socket: WsSocket) {
    this.#socket = socket;
    socket.on("message", (data: RawData) => {
      for (const listener of this.#messages) listener(bytesOf(data));
    });
    socket.on("ping", () => {
      for (const listener of this.#pings) listener();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.#closed = { code, reason: reason.toString("utf8") };
      for (const listener of this.#closes) listener(code, this.#closed.reason);
    });
    socket.on("error", () => undefined);
  }

  send(bytes: Uint8Array): void {
    this.#socket.send(bytes);
  }

  close(code: number, reason: string): void {
    this.#socket.close(code, reason);
  }

  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#messages.push(listener);
  }

  onPing(listener: () => void): void {
    this.#pings.push(listener);
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.#closes.push(listener);
    if (this.#closed !== undefined) listener(this.#closed.code, this.#closed.reason);
  }
}

// why: `ws` is loaded with `import()` on the first `connect`, so the CLI and the MCP server, which import the ports barrel, load it only when a command opens a socket (ADR 0054 section 8).
export class NodeWebSocketClientConnector implements WebSocketClientConnector {
  async connect(url: string, options: WebSocketClientOptions): Promise<WebSocketClient> {
    const { WebSocket } = await import("ws");
    return new Promise<WebSocketClient>((resolve, reject) => {
      const socket = new WebSocket(url, {
        autoPong: true,
        handshakeTimeout: options.handshakeTimeoutMs,
        headers: { ...options.headers },
      });
      socket.once("unexpected-response", (_request, response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          reject(
            new WebSocketRefusedError(
              response.statusCode ?? 0,
              Buffer.concat(chunks).toString("utf8"),
            ),
          );
        });
        response.on("error", () => {
          reject(new WebSocketRefusedError(response.statusCode ?? 0, ""));
        });
      });
      socket.once("error", reject);
      socket.once("open", () => {
        socket.off("error", reject);
        resolve(new NodeWebSocketClient(socket));
      });
    });
  }
}

class FakeWebSocketPeer implements WebSocketClient {
  readonly sent: Uint8Array[] = [];
  closedWith: { readonly code: number; readonly reason: string } | undefined;
  // why: a real socket answers `close` with its own close event; a test sets this to play a server that never answers.
  silentOnClose = false;
  readonly #messages: ((bytes: Uint8Array) => void)[] = [];
  readonly #pings: (() => void)[] = [];
  readonly #closes: ((code: number, reason: string) => void)[] = [];

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    if (this.silentOnClose) return;
    for (const listener of this.#closes) listener(code, reason);
  }

  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#messages.push(listener);
  }

  onPing(listener: () => void): void {
    this.#pings.push(listener);
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.#closes.push(listener);
  }

  receive(bytes: Uint8Array): void {
    for (const listener of this.#messages) listener(bytes);
  }

  ping(): void {
    for (const listener of this.#pings) listener();
  }

  dropped(code: number, reason: string): void {
    for (const listener of this.#closes) listener(code, reason);
  }
}

export class FakeWebSocketClientConnector implements WebSocketClientConnector {
  readonly connections: {
    readonly url: string;
    readonly options: WebSocketClientOptions;
    readonly peer: FakeWebSocketPeer;
  }[] = [];
  // why: a test sets this to make the next `connect` fail, as a refused upgrade or an unreachable host does.
  failure: Error | undefined;

  async connect(url: string, options: WebSocketClientOptions): Promise<WebSocketClient> {
    if (this.failure !== undefined) throw this.failure;
    const peer = new FakeWebSocketPeer();
    this.connections.push({ options, peer, url });
    return peer;
  }
}
