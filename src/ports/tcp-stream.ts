import { createConnection, type Socket } from "node:net";

// why: `TcpProbe` answers one question and hangs up; a device's video socket reached through adb
// keeps talking for as long as someone watches.
export interface TcpStreamConnector {
  connect(port: number, timeoutMs: number): Promise<TcpStream>;
}

export interface TcpStream {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array | string): Promise<void>;
  // why: half-close, so the peer sees this side's bytes end while it can still write back; `close` ends both.
  end(): void;
  close(): void;
}

// why: `Readable.toWeb` waits for the socket to close, not for the peer's FIN, so a peer's half-close would never end the stream; this one ends on `end`, and on an error or close too.
function readableOf(socket: Socket): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    // why: a cancelled stream is already closed, and the `close` the destroy raises must not close it again, which throws outside any handler.
    cancel: () => {
      finished = true;
      socket.destroy();
    },
    pull: () => {
      socket.resume();
    },
    start: (controller) => {
      const finish = () => {
        if (finished) return;
        finished = true;
        controller.close();
      };
      socket.on("data", (chunk: Buffer) => {
        if (finished) return;
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) socket.pause();
      });
      socket.on("end", finish);
      socket.on("close", finish);
      socket.on("error", finish);
    },
  });
}

// why: a socket error with no listener is raised by Node as an uncaught exception and takes the daemon down, so one always exists; `readableOf` ends the readable on it.
export function tcpStreamOf(socket: Socket): TcpStream {
  socket.on("error", () => undefined);
  return {
    close: () => {
      socket.destroy();
    },
    end: () => {
      socket.end();
    },
    readable: readableOf(socket),
    write: (bytes) =>
      new Promise<void>((done, failed) => {
        socket.write(bytes, (error) => (error ? failed(error) : done()));
      }),
  };
}

export class NodeTcpStreamConnector implements TcpStreamConnector {
  connect(port: number, timeoutMs: number): Promise<TcpStream> {
    return new Promise<TcpStream>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = createConnection({ host: "127.0.0.1", port });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(timeoutMs, () =>
        fail(new Error(`No connection to 127.0.0.1:${String(port)} within ${String(timeoutMs)}ms`)),
      );
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.off("error", fail);
        resolve(tcpStreamOf(socket));
      });
    });
  }
}

export class FakeTcpPeer {
  readonly written: Uint8Array[] = [];
  closed = false;
  // why: the device's side ended its bytes, which a test tells from the worker having closed the connection.
  ended = false;
  // why: a test sets this to make every write to the device fail, as a broken device socket does.
  writeFailure: Error | undefined;
  // why: the driver half-closed its side, as `stream.end()` does; `end()` on the peer is the device's side ending.
  writeEnded = false;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly stream: TcpStream;

  constructor() {
    const readable = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.closed = true;
      },
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.stream = {
      close: () => {
        if (this.closed) return;
        this.closed = true;
        this.#closeReadable();
      },
      end: () => {
        this.writeEnded = true;
      },
      readable,
      write: async (bytes) => {
        if (this.writeFailure !== undefined) throw this.writeFailure;
        this.written.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
      },
    };
  }

  // fallow-ignore-next-line unused-class-member -- read by the tests that drive a fake stream.
  writtenText(): string {
    return this.written.map((chunk) => new TextDecoder().decode(chunk)).join("");
  }

  // fallow-ignore-next-line unused-class-member -- the device's side of a fake stream, called by tests.
  send(bytes: Uint8Array | string): void {
    if (this.closed || this.ended) return;
    this.#controller.enqueue(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  }

  // fallow-ignore-next-line unused-class-member -- the device's side ending, called by tests.
  end(): void {
    this.ended = true;
    this.#closeReadable();
  }

  #closeReadable(): void {
    try {
      this.#controller.close();
    } catch {
      // why: a cancelled or already ended readable is closed; ending the connection is still done.
    }
  }
}

export class FakeTcpStreamConnector implements TcpStreamConnector {
  readonly connections: { readonly port: number; readonly peer: FakeTcpPeer }[] = [];

  // why: a test lists the ports nothing listens on; connecting to one rejects, as a refused loopback connection does.
  readonly refusedPorts = new Set<number>();

  async connect(port: number): Promise<TcpStream> {
    if (this.refusedPorts.has(port)) {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:${String(port)}`);
    }
    const peer = new FakeTcpPeer();
    this.connections.push({ peer, port });
    return peer.stream;
  }
}
