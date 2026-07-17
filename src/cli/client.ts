import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PROTOCOL_VERSION } from "../daemon/server.js";
import { DaemonClientError, type DaemonConnection } from "./protocol.js";

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (payload: unknown) => void;
}
export interface ConnectDaemonOptions {
  readonly dataDirectory: string;
  readonly socketPath: string;
}

export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonConnection> {
  try {
    return await connectExistingDaemon(options.socketPath);
  } catch (error: unknown) {
    if (!isMissingDaemon(error)) throw error;
  }
  startDaemon(options.dataDirectory);
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectExistingDaemon(options.socketPath);
    } catch (error: unknown) {
      lastError = error;
      await delay(50);
    }
  }
  throw new Error(`Timed out starting pitlane daemon: ${errorMessage(lastError)}`);
}

export async function connectExistingDaemon(socketPath: string): Promise<DaemonConnection> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const connection = new NodeDaemonConnection(socket);
  await connection.request("hello", {
    clientVersion: "1.0.0",
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
  });
  return connection;
}

class NodeDaemonConnection implements DaemonConnection {
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  readonly #pending = new Map<number, PendingRequest>();
  #buffer = "";
  #nextId = 1;
  #closed = false;
  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#read(chunk));
    socket.once("error", (error) => this.#failPending(error));
    socket.once("close", () => this.#failPending(new Error("Daemon connection closed")));
  }
  request(type: string, payload: unknown): Promise<unknown> {
    if (this.#closed || this.socket.destroyed)
      return Promise.reject(new Error("Daemon connection is closed"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.socket.write(`${JSON.stringify({ id, payload, type })}\n`);
    });
  }
  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.end();
    });
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
  #dispatch(value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.#failPending(new Error("Daemon sent an invalid frame"));
      return;
    }
    const frame = value as Record<string, unknown>;
    if (typeof frame.push === "string") {
      for (const listener of this.#listeners) listener(frame.push, frame.payload);
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.payload);
      return;
    }
    const details =
      typeof frame.error === "object" && frame.error !== null && !Array.isArray(frame.error)
        ? (frame.error as Record<string, unknown>)
        : {};
    pending.reject(
      new DaemonClientError(
        typeof details.code === "string" ? details.code : "INTERNAL",
        typeof details.message === "string" ? details.message : "Daemon request failed",
      ),
    );
  }
  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function startDaemon(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true });
  const log = openSync(join(dataDirectory, "daemon.log"), "a");
  try {
    const daemonEntrypoint = join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js");
    const child = spawn(process.execPath, [daemonEntrypoint], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function isMissingDaemon(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ECONNREFUSED")
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
