import type { IpcConnection } from "../ports/index.js";
import { DaemonClientError, type DaemonConnection, parseDaemonResponse } from "./protocol.js";

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (payload: unknown) => void;
}

export class IpcDaemonConnection implements DaemonConnection {
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  readonly #pending = new Map<number, PendingRequest>();
  #buffer = "";
  #nextId = 1;
  #closed = false;

  constructor(private readonly connection: IpcConnection) {
    connection.onData((chunk) => this.#read(chunk));
    connection.onError((error) => this.#failPending(error));
    connection.onClose(() => this.#failPending(new Error("Daemon connection closed")));
  }

  request(type: string, payload: unknown): Promise<unknown> {
    if (this.#closed || this.connection.closed)
      return Promise.reject(new Error("Daemon connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      void this.connection
        .write(`${JSON.stringify({ id, payload, type })}\n`)
        .catch((error: unknown) => {
          this.#pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.connection.close();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      try {
        this.#dispatch(JSON.parse(line) as unknown);
      } catch {
        this.#failPending(new Error("Daemon sent invalid JSON"));
      }
    }
  }

  // fallow-ignore-next-line complexity -- response frame variants are deliberately handled at one boundary.
  #dispatch(value: unknown): void {
    const frame = parseDaemonResponse(value);
    if (frame === undefined) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return;
      this.#failPending(new Error("Daemon sent an invalid frame"));
      return;
    }
    if (frame.kind === "push") {
      for (const listener of this.#listeners) listener(frame.push, frame.payload);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    if (frame.kind === "success") pending.resolve(frame.payload);
    else {
      const details = asRecord(frame.error);
      pending.reject(
        new DaemonClientError(
          typeof details.code === "string" ? details.code : "INTERNAL",
          typeof details.message === "string" ? details.message : "Daemon request failed",
        ),
      );
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
