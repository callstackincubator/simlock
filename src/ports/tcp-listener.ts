import { createServer, type Socket } from "node:net";

import { FakeTcpPeer, type LoopbackHost, type TcpStream, tcpStreamOf } from "./tcp-stream.js";

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
  listen(port: number, host?: LoopbackHost): Promise<TcpListener | undefined>;
}

export class NodeTcpListenerFactory implements TcpListenerFactory {
  listen(port: number, host: LoopbackHost = "127.0.0.1"): Promise<TcpListener | undefined> {
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
      server.listen(port, host, () => {
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
          // why: asked for port 0 the OS picks one, and the caller needs the one it picked.
          port: typeof bound === "object" && bound !== null ? bound.port : port,
        });
      });
    });
  }
}

class FakeTcpListener implements TcpListener {
  closed = false;
  readonly #listeners: ((stream: TcpStream) => void)[] = [];

  constructor(
    readonly port: number,
    readonly address: LoopbackHost,
  ) {}

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
  // why: a test adds `<host>:<port>` to make a port taken on one loopback address only.
  readonly busyOn = new Set<string>();
  readonly listeners: FakeTcpListener[] = [];

  #nextFree = 49_152;

  listen(requested: number, host: LoopbackHost = "127.0.0.1"): Promise<TcpListener | undefined> {
    // why: port 0 asks for any free port, as on a real machine; the fake hands out its own, counting up from the dynamic range.
    const port = requested === 0 ? this.#nextFree++ : requested;
    if (this.busy.has(port) || this.busyOn.has(`${host}:${String(port)}`)) {
      return Promise.resolve(undefined);
    }
    const listener = new FakeTcpListener(port, host);
    this.listeners.push(listener);
    return Promise.resolve(listener);
  }
}
