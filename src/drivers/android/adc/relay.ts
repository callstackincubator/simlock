import type {
  TcpListenerFactory,
  TcpListener,
  TcpStream,
  WebSocketClient,
  WebSocketClientConnector,
} from "../../../ports/index.js";
import type { CloudApi } from "./api.js";

export interface CloudAdbConnection {
  readonly serial: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface CloudAdbRelayOptions {
  readonly api: Pick<CloudApi, "adbUrl" | "authorizationHeaders">;
  readonly listeners: TcpListenerFactory;
  readonly webSockets: WebSocketClientConnector;
}

export class CloudAdbRelay {
  readonly #leases = new Set<string>();

  constructor(private readonly options: CloudAdbRelayOptions) {}

  async open(leaseId: string, port = 0): Promise<CloudAdbConnection> {
    if (this.#leases.has(leaseId))
      throw new Error("AgentDeviceCloud lease already has an ADB bridge");
    this.#leases.add(leaseId);
    let listener: TcpListener;
    try {
      const bound = await this.options.listeners.listen(port, "127.0.0.1");
      if (bound === undefined) throw new Error("Could not open the AgentDeviceCloud ADB bridge");
      listener = bound;
    } catch (error: unknown) {
      this.#leases.delete(leaseId);
      throw error;
    }
    const pending = new Set<Promise<void>>();
    let closed = false;
    let occupied = false;
    let socket: WebSocketClient | undefined;
    let stream: TcpStream | undefined;
    const closeTransport = (): void => {
      socket?.terminate();
      socket = undefined;
      stream?.close();
    };
    const connect = async (incoming: TcpStream): Promise<void> => {
      if (closed || occupied) {
        incoming.close();
        return;
      }
      occupied = true;
      stream = incoming;
      try {
        const url = this.options.api.adbUrl(leaseId);
        const headers = this.options.api.authorizationHeaders();
        const connected = await this.options.webSockets.connect(url, {
          headers,
          handshakeTimeoutMs: 10_000,
        });
        socket = connected;
        if (closed) return;
        let writes = Promise.resolve();
        connected.onMessage((bytes) => {
          const write = () => incoming.write(bytes);
          writes = writes.then(write);
          void writes.catch(closeTransport);
        });
        const closeIncoming = () => incoming.close();
        connected.onClose(closeIncoming);
        const reader = incoming.readable.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            connected.send(chunk.value);
          }
          await writes;
        } finally {
          reader.releaseLock();
        }
      } catch {
        incoming.close();
      } finally {
        closeTransport();
        stream = undefined;
        occupied = false;
      }
    };
    listener.onConnection((incoming) => {
      const task = connect(incoming);
      pending.add(task);
      const forget = (): void => {
        pending.delete(task);
      };
      void task.finally(forget);
    });
    return {
      serial: `127.0.0.1:${String(listener.port)}`,
      port: listener.port,
      close: async () => {
        if (closed) return;
        closed = true;
        closeTransport();
        await listener.close();
        await Promise.all(pending);
        this.#leases.delete(leaseId);
      },
    };
  }
}
