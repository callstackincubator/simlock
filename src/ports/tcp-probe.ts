import { createConnection, type Socket } from "node:net";

/**
 * Asks whether a loopback port is in use. Simlock needs this to decide whether the port
 * it wants for its own server is already taken, which is a fail-closed decision rather
 * than a diagnostic one -- see ADR 0001.
 */
export interface TcpProbe {
  /** True when something is accepting connections on `127.0.0.1:<port>` right now. */
  isListening(port: number, timeoutMs?: number): Promise<boolean>;
}

/**
 * Short by design: this probes loopback, where a connection either completes almost
 * immediately or is not going to. It is also called in a polling loop while waiting for a
 * server to come up, so a generous timeout would slow that loop down for no information.
 */
const DEFAULT_TIMEOUT_MS = 250;

export class NodeTcpProbe implements TcpProbe {
  async isListening(port: number, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let socket: Socket;
      try {
        socket = createConnection({ host: "127.0.0.1", port });
      } catch {
        // `createConnection` throws synchronously (`ERR_SOCKET_BAD_PORT`) for a port
        // outside 0-65535 or one that is not an integer. That has to answer like every
        // other failure here -- nothing is serving a port nothing can listen on -- or a
        // misconfigured port number would reject out of a call whose whole contract is to
        // report `true` or `false`.
        resolve(false);
        return;
      }

      const settle = (listening: boolean): void => {
        socket.destroy();
        resolve(listening);
      };

      socket.setTimeout(timeoutMs);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      // A refused connection is the expected answer for a free port, not a failure to
      // report: everything that goes wrong here means "nothing is serving this port".
      socket.once("error", () => settle(false));
    });
  }
}

export class FakeTcpProbe implements TcpProbe {
  readonly #listening = new Set<number>();

  constructor(listeningPorts: readonly number[] = []) {
    for (const port of listeningPorts) {
      this.#listening.add(port);
    }
  }

  async isListening(port: number): Promise<boolean> {
    return this.#listening.has(port);
  }

  startListening(port: number): void {
    this.#listening.add(port);
  }

  stopListening(port: number): void {
    this.#listening.delete(port);
  }
}
