import { createServer, type Socket } from "node:net";

import { FakeTcpPeer, type TcpStream, tcpStreamOf } from "./tcp-stream.js";

// why: a device reached through `adb reverse` connects to a port on this machine; the driver owns
// that port for as long as the rule stands, and every connection to it arrives on `onConnection`.
export interface TcpListener {
  readonly port: number;
  // why: the interface the listener is bound to, so a test can prove a tunnel's port is reachable from this machine only.
  readonly address: string;
  onConnection(listener: (stream: TcpStream) => void): void;
  close(): Promise<void>;
}

export interface TcpListenerFactory {
  // why: `undefined` is a port someone else holds, so a caller walking a range can go on to the next.
  listen(port: number): Promise<TcpListener | undefined>;
}

export class NodeTcpListenerFactory implements TcpListenerFactory {
  listen(port: number): Promise<TcpListener | undefined> {
    return new Promise((resolve, reject) => {
      // why: END is a half-close, so the device ending its bytes must not end the worker's side too.
      const server = createServer({ allowHalfOpen: true });
      const listeners: ((stream: TcpStream) => void)[] = [];
      const open = new Set<Socket>();
      server.on("connection", (socket) => {
        open.add(socket);
        socket.once("close", () => open.delete(socket));
        const stream = tcpStreamOf(socket);
        for (const listener of listeners) listener(stream);
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(undefined);
        else reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        server.on("error", () => undefined);
        const bound = server.address();
        resolve({
          address: typeof bound === "object" && bound !== null ? bound.address : "",
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
              for (const socket of open) socket.destroy();
            }),
          onConnection: (listener) => {
            listeners.push(listener);
          },
          port,
        });
      });
    });
  }
}

class FakeTcpListener implements TcpListener {
  closed = false;
  readonly #listeners: ((stream: TcpStream) => void)[] = [];

  readonly address = "127.0.0.1";

  constructor(readonly port: number) {}

  onConnection(listener: (stream: TcpStream) => void): void {
    this.#listeners.push(listener);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  connect(): FakeTcpPeer {
    const peer = new FakeTcpPeer();
    for (const listener of this.#listeners) listener(peer.stream);
    return peer;
  }
}

export class FakeTcpListenerFactory implements TcpListenerFactory {
  // why: a test adds a port here to make it taken, as another process on the machine would.
  readonly busy = new Set<number>();
  readonly listeners: FakeTcpListener[] = [];

  listen(port: number): Promise<TcpListener | undefined> {
    if (this.busy.has(port)) return Promise.resolve(undefined);
    const listener = new FakeTcpListener(port);
    this.listeners.push(listener);
    return Promise.resolve(listener);
  }
}
