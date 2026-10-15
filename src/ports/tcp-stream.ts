import { createConnection, type Socket } from "node:net";
import { Readable } from "node:stream";

// why: `TcpProbe` answers one question and hangs up; a device's video socket reached through adb
// keeps talking for as long as someone watches.
export interface TcpStreamConnector {
  connect(port: number, timeoutMs: number): Promise<TcpStream>;
}

export interface TcpStream {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array | string): Promise<void>;
  close(): void;
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
        // why: after connect an error ends the readable through `Readable.toWeb`; a listener must
        // still exist or Node raises it as an uncaught exception and takes the daemon down.
        socket.on("error", () => undefined);
        resolve({
          close: () => {
            socket.destroy();
          },
          readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
          write: (bytes) =>
            new Promise<void>((done, failed) => {
              socket.write(bytes, (error) => (error ? failed(error) : done()));
            }),
        });
      });
    });
  }
}

// fallow-ignore-next-line unused-export -- the public shape of FakeTcpStreamConnector.connections.
export class FakeTcpPeer {
  readonly written: Uint8Array[] = [];
  closed = false;
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
        try {
          this.#controller.close();
        } catch {
          // why: a cancelled readable is already closed; closing the connection is still done.
        }
      },
      readable,
      write: async (bytes) => {
        this.written.push(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
      },
    };
  }

  writtenText(): string {
    return this.written.map((chunk) => new TextDecoder().decode(chunk)).join("");
  }

  send(bytes: Uint8Array | string): void {
    if (this.closed) return;
    this.#controller.enqueue(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
  }

  end(): void {
    this.stream.close();
  }
}

export class FakeTcpStreamConnector implements TcpStreamConnector {
  readonly connections: { readonly port: number; readonly peer: FakeTcpPeer }[] = [];

  async connect(port: number): Promise<TcpStream> {
    const peer = new FakeTcpPeer();
    this.connections.push({ peer, port });
    return peer.stream;
  }
}
