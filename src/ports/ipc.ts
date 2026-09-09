import { createServer, connect, type Server, type Socket } from "node:net";

export type IpcErrorCode =
  | "address-in-use"
  | "connection-refused"
  | "endpoint-not-found"
  | "unknown";

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly cause: unknown,
  ) {
    super(message, { cause });
    this.name = "IpcError";
  }
}

export interface IpcConnection {
  readonly closed: boolean;
  onData(listener: (chunk: string) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  write(contents: string): Promise<void>;
  close(): Promise<void>;
}

export interface IpcListener {
  close(): Promise<void>;
}

export interface IpcConnector {
  connect(endpoint: string): Promise<IpcConnection>;
}

export interface IpcListenerFactory {
  listen(endpoint: string, accept: (connection: IpcConnection) => void): Promise<IpcListener>;
}

/** Node's Unix-domain socket adapter. Kept at the infrastructure boundary. */
export class NodeIpcTransport implements IpcConnector, IpcListenerFactory {
  async connect(endpoint: string): Promise<IpcConnection> {
    const socket = connect(endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off("connect", onConnect);
          reject(normalizeIpcError(error));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
    } catch (error: unknown) {
      socket.destroy();
      throw error;
    }
    return new NodeIpcConnection(socket);
  }

  async listen(
    endpoint: string,
    accept: (connection: IpcConnection) => void,
  ): Promise<IpcListener> {
    const server = createServer((socket) => accept(new NodeIpcConnection(socket)));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(normalizeIpcError(error));
        server.once("error", onError);
        server.listen(endpoint, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch (error: unknown) {
      server.close();
      throw error;
    }
    return new NodeIpcListener(server);
  }
}

class NodeIpcConnection implements IpcConnection {
  #closed = false;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.once("close", () => {
      this.#closed = true;
    });
  }

  get closed(): boolean {
    return this.#closed || this.socket.destroyed;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.socket.on("data", listener);
    return () => this.socket.off("data", listener);
  }

  onClose(listener: () => void): () => void {
    this.socket.once("close", listener);
    return () => this.socket.off("close", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    const normalized = (error: Error) => listener(normalizeIpcError(error));
    this.socket.once("error", normalized);
    return () => this.socket.off("error", normalized);
  }

  write(contents: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.write(contents, (error) => {
        if (error == null) resolve();
        else reject(normalizeIpcError(error));
      });
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", resolve);
      this.socket.end();
    });
  }
}

class NodeIpcListener implements IpcListener {
  #closed = false;

  constructor(private readonly server: Server) {}

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return new Promise((resolve, reject) => {
      this.server.close((error) =>
        error === undefined ? resolve() : reject(normalizeIpcError(error)),
      );
    });
  }
}

/** Deterministic in-memory paired connections for application tests. */
export class MemoryIpcTransport implements IpcConnector, IpcListenerFactory {
  readonly #listeners = new Map<string, (connection: IpcConnection) => void>();

  async connect(endpoint: string): Promise<IpcConnection> {
    const accept = this.#listeners.get(endpoint);
    if (accept === undefined) {
      throw new IpcError("endpoint-not-found", `No IPC endpoint at ${endpoint}`, undefined);
    }
    const client = new MemoryIpcConnection();
    const server = new MemoryIpcConnection();
    client.pair(server);
    server.pair(client);
    accept(server);
    return client;
  }

  async listen(
    endpoint: string,
    accept: (connection: IpcConnection) => void,
  ): Promise<IpcListener> {
    if (this.#listeners.has(endpoint)) {
      throw new IpcError(
        "address-in-use",
        `IPC endpoint is already in use: ${endpoint}`,
        undefined,
      );
    }
    this.#listeners.set(endpoint, accept);
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        this.#listeners.delete(endpoint);
      },
    };
  }
}

/**
 * Adds `listener` to `listeners` and returns the unsubscribe every `on*` method on
 * `IpcConnection` hands back.
 *
 * Three lines, but written out per event per implementation it was nine copies of the same
 * add-then-delete dance across the in-memory transport, the paired connection behind the
 * uplink port, and the WebSocket adapter -- and the dance is all they shared, since what
 * differs between those classes is what *emits*, never how one subscribes. Set-backed
 * implementations only: `NodeIpcConnection` above delegates to the socket's own
 * `EventEmitter`, which already owns this bookkeeping.
 */
export function subscribeListener<Listener>(
  listeners: Set<Listener>,
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

class MemoryIpcConnection implements IpcConnection {
  readonly #closeListeners = new Set<() => void>();
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  #peer: MemoryIpcConnection | undefined;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  pair(peer: MemoryIpcConnection): void {
    this.#peer = peer;
  }

  onData(listener: (chunk: string) => void): () => void {
    return subscribeListener(this.#dataListeners, listener);
  }

  onClose(listener: () => void): () => void {
    return subscribeListener(this.#closeListeners, listener);
  }

  onError(listener: (error: Error) => void): () => void {
    return subscribeListener(this.#errorListeners, listener);
  }

  async write(contents: string): Promise<void> {
    const peer = this.#peer;
    if (this.#closed || peer === undefined || peer.#closed) return;
    for (const listener of peer.#dataListeners) listener(contents);
  }

  async close(): Promise<void> {
    this.#close();
    const peer = this.#peer;
    if (peer !== undefined) peer.#close();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

// fallow-ignore-next-line unused-export complexity -- public normalization of the finite Node transport errno set.
export function normalizeIpcError(error: unknown): IpcError {
  if (error instanceof IpcError) return error;
  const nodeCode =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const code: IpcErrorCode =
    nodeCode === "EADDRINUSE"
      ? "address-in-use"
      : nodeCode === "ECONNREFUSED"
        ? "connection-refused"
        : nodeCode === "ENOENT" || nodeCode === "ENOTSOCK"
          ? "endpoint-not-found"
          : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  return new IpcError(code, message, error);
}
