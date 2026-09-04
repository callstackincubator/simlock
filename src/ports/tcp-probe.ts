import { createConnection, type Socket } from "node:net";

/**
 * Asks whether a loopback port is in use. Simlock needs this to decide whether the port
 * it wants for its own server is already taken, which is a fail-closed decision rather
 * than a diagnostic one -- see ADR 0001.
 */
export interface TcpProbe {
  /** True when something is accepting connections on `127.0.0.1:<port>` right now. */
  isListening(port: number, timeoutMs?: number): Promise<boolean>;
  /**
   * Writes `payload` to `127.0.0.1:<port>` and resolves with whatever came back before the
   * peer closed or the timeout elapsed -- an empty string when it answered nothing.
   *
   * Deliberately dumb: what the bytes mean belongs to the caller (adb's host-service
   * framing is the Android driver's business), while opening a loopback socket is an
   * external API and so belongs behind a port like every other one (architecture rule 9).
   * Rejects only when the connection itself failed, because a caller cannot tell "the
   * server said nothing" from "there was no server" if both resolve the same way.
   */
  send(port: number, payload: string, timeoutMs?: number): Promise<string>;
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

  async send(
    port: number,
    payload: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = createConnection({ host: "127.0.0.1", port });
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let received = "";
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        outcome();
      };

      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => socket.write(payload));
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      // A peer that answers and then holds the connection open is the normal case for the
      // one service this carries, so the timeout is a completion condition rather than a
      // failure: whatever arrived by then is the answer.
      socket.once("timeout", () => settle(() => resolve(received)));
      socket.once("close", () => settle(() => resolve(received)));
      socket.once("error", (error) => settle(() => reject(error)));
    });
  }
}

export interface FakeSend {
  readonly port: number;
  readonly payload: string;
}

export class FakeTcpProbe implements TcpProbe {
  /** Every `send` this probe was asked to make, in order. */
  readonly sends: FakeSend[] = [];
  readonly #listening = new Set<number>();
  #reply = "";
  #sendFailure: Error | undefined;

  constructor(listeningPorts: readonly number[] = []) {
    for (const port of listeningPorts) {
      this.#listening.add(port);
    }
  }

  async isListening(port: number): Promise<boolean> {
    return this.#listening.has(port);
  }

  async send(port: number, payload: string): Promise<string> {
    this.sends.push({ payload, port });

    if (this.#sendFailure !== undefined) {
      throw this.#sendFailure;
    }

    return this.#reply;
  }

  replyWith(reply: string): void {
    this.#reply = reply;
  }

  failSendsWith(error: Error): void {
    this.#sendFailure = error;
  }

  startListening(port: number): void {
    this.#listening.add(port);
  }

  stopListening(port: number): void {
    this.#listening.delete(port);
  }
}
