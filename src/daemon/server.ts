import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { type EventBus, type EventEnvelope } from "../bus/index.js";
import {
  HeldLeaseRenewalError,
  type Config,
  type DeviceRequest,
  LeaseEngine,
  type LeaseProgress,
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  type Registry,
  RequesterAlreadyLeasedError,
  RuntimeMissingError,
  UnknownModelError,
  type CleanupReaper,
  type Doctor,
  type Nuke,
  UnknownLeaseError,
} from "../core/index.js";
import type { Filesystem } from "../ports/index.js";

export const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_SOCKET_PATH = "~/.pitlane/daemon.sock";

type RequestId = string | number;

interface RequestFrame {
  readonly id: RequestId;
  readonly type: string;
  readonly payload: unknown;
}

interface Connection {
  readonly socket: Socket;
  readonly heldLeaseIds: Set<string>;
  readonly progressDisposers: Set<() => void>;
  readonly progressRequesters: Set<string>;
  buffer: string;
  helloReceived: boolean;
  closed: boolean;
  unsubscribeEvents: (() => void) | undefined;
  releasing: Promise<void> | undefined;
}

export interface DaemonServerOptions {
  readonly config: Config;
  readonly doctor?: Doctor;
  readonly defaultRequesterId: string;
  readonly eventBus: EventBus;
  readonly filesystem: Filesystem;
  readonly leaseEngine: LeaseEngine;
  readonly protocolVersion?: number;
  readonly reaper: CleanupReaper;
  readonly nuke?: Nuke;
  readonly registry: Registry;
  readonly socketPath?: string;
  readonly version: string;
}

class DaemonAlreadyRunningError extends Error {
  constructor(readonly socketPath: string) {
    super(`Pitlane daemon is already running at ${socketPath}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class DaemonServer {
  readonly #connections = new Set<Connection>();
  readonly #protocolVersion: number;
  readonly #socketPath: string;
  #server: Server | undefined;
  #ownsSocket = false;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;

  constructor(private readonly options: DaemonServerOptions) {
    this.#protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.#socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) {
      throw new Error("Daemon server has already been started");
    }
    await this.#claimSocket();

    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await listen(server, this.#socketPath);
    } catch (error: unknown) {
      this.#server = undefined;
      if (isAddressInUse(error)) {
        throw new DaemonAlreadyRunningError(this.#socketPath);
      }
      throw error;
    }
    this.#ownsSocket = true;

    this.options.eventBus.emit(
      "daemon.started",
      { configSnapshot: this.options.config, version: this.options.version },
      "daemon",
    );
  }

  stop(reason = "requested"): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#stopping = true;
    this.#stopPromise = this.#stop(reason);
    return this.#stopPromise;
  }

  async #stop(reason: string): Promise<void> {
    this.options.eventBus.emit("daemon.stopping", { reason }, "daemon");
    this.options.reaper.dispose();
    const server = this.#server;
    const serverClosed = server === undefined ? Promise.resolve() : closeServer(server);

    await Promise.all([...this.#connections].map((connection) => this.#releaseHeld(connection)));
    for (const connection of this.#connections) {
      connection.socket.end();
    }
    await serverClosed;
    this.#server = undefined;
    if (this.#ownsSocket) {
      await this.options.filesystem.rm(this.#socketPath);
      this.#ownsSocket = false;
    }
  }

  async #claimSocket(): Promise<void> {
    await this.options.filesystem.mkdirp(dirname(this.#socketPath));
    if (!(await this.options.filesystem.exists(this.#socketPath))) {
      return;
    }

    if (await isLiveSocket(this.#socketPath)) {
      throw new DaemonAlreadyRunningError(this.#socketPath);
    }
    await this.options.filesystem.rm(this.#socketPath);
  }

  #accept(socket: Socket): void {
    if (this.#stopping) {
      socket.end();
      return;
    }
    const connection: Connection = {
      buffer: "",
      closed: false,
      helloReceived: false,
      heldLeaseIds: new Set(),
      progressDisposers: new Set(),
      progressRequesters: new Set(),
      socket,
      releasing: undefined,
      unsubscribeEvents: undefined,
    };
    this.#connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#read(connection, chunk));
    socket.once("close", () => this.#closeConnection(connection));
    socket.once("error", () => this.#closeConnection(connection));
  }

  #read(connection: Connection, chunk: string): void {
    connection.buffer += chunk;
    for (;;) {
      const newline = connection.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line.trim() === "") {
        continue;
      }
      void this.#dispatchLine(connection, line);
    }
  }

  async #dispatchLine(connection: Connection, line: string): Promise<void> {
    let frame: RequestFrame;
    try {
      frame = parseRequestFrame(line);
    } catch (error: unknown) {
      await this.#respondError(connection.socket, null, "BAD_FRAME", errorMessage(error));
      return;
    }

    if (!connection.helloReceived) {
      await this.#handleHello(connection, frame);
      return;
    }
    if (this.#stopping) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "DAEMON_STOPPING",
        "Daemon is stopping",
      );
      return;
    }

    try {
      const payload = await this.#handleRequest(connection, frame);
      await writeFrame(connection.socket, { id: frame.id, ok: true, payload });
      if (frame.type === "daemon.stop") {
        void this.stop("requested");
      }
    } catch (error: unknown) {
      await this.#respondError(connection.socket, frame.id, errorCode(error), errorMessage(error));
    }
  }

  async #handleHello(connection: Connection, frame: RequestFrame): Promise<void> {
    if (frame.type !== "hello") {
      await this.#respondError(
        connection.socket,
        frame.id,
        "HANDSHAKE_REQUIRED",
        "First message must be hello",
      );
      connection.socket.end();
      return;
    }
    const payload = objectPayload(frame.payload);
    if (typeof payload.clientVersion !== "string") {
      await this.#respondError(
        connection.socket,
        frame.id,
        "BAD_REQUEST",
        "hello requires a clientVersion string",
      );
      connection.socket.end();
      return;
    }
    if (payload.protocolVersion !== this.#protocolVersion) {
      await this.#respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_MISMATCH",
        `Protocol version ${String(payload.protocolVersion)} is not supported`,
      );
      connection.socket.end();
      return;
    }
    connection.helloReceived = true;
    await writeFrame(connection.socket, {
      id: frame.id,
      ok: true,
      payload: { protocolVersion: this.#protocolVersion, version: this.options.version },
    });
  }

  async #handleRequest(connection: Connection, frame: RequestFrame): Promise<unknown> {
    switch (frame.type) {
      case "lease.request":
        return this.#requestLease(connection, frame.payload);
      case "lease.release": {
        const leaseId = requiredString(objectPayload(frame.payload), "leaseId");
        await this.options.leaseEngine.release(leaseId, "explicit");
        connection.heldLeaseIds.delete(leaseId);
        return { leaseId };
      }
      case "lease.release-all": {
        const leaseIds = await this.options.leaseEngine.releaseAll("explicit");
        connection.heldLeaseIds.clear();
        return { leaseIds };
      }
      case "lease.renew": {
        const payload = objectPayload(frame.payload);
        const leaseId = requiredString(payload, "leaseId");
        const ttlMs =
          payload.ttlMs === undefined
            ? this.options.config.lease.detachedTtlMs
            : requiredNumber(payload, "ttlMs");
        return this.options.leaseEngine.renew(leaseId, ttlMs);
      }
      case "status.get":
        return this.#status();
      case "list.get":
        return this.#list(objectPayload(frame.payload));
      case "cleanup.run": {
        const payload = objectPayload(frame.payload);
        return this.options.reaper.run({
          dryRun: optionalBoolean(payload, "dryRun") ?? false,
          ...(typeof payload.rule === "string" ? { rule: payload.rule } : {}),
        });
      }
      case "doctor.run": {
        const payload = objectPayload(frame.payload);
        if (this.options.doctor === undefined) throw new Error("Doctor is unavailable");
        return this.options.doctor.reconcile({ fix: optionalBoolean(payload, "fix") ?? false });
      }
      case "nuke.run": {
        const payload = objectPayload(frame.payload);
        if (this.options.nuke === undefined) throw new Error("Nuke is unavailable");
        return this.options.nuke.run({
          deleteDevices: optionalBoolean(payload, "deleteDevices") ?? false,
        });
      }
      case "events.replay": {
        const payload = objectPayload(frame.payload);
        return this.options.eventBus.replay(
          typeof payload.sinceTs === "number" ? { sinceTs: payload.sinceTs } : {},
        );
      }
      case "events.subscribe":
        connection.unsubscribeEvents?.();
        connection.unsubscribeEvents = this.options.eventBus.subscribeAll((event) => {
          void this.#pushEvent(connection.socket, event);
        });
        return { subscribed: true };
      case "events.unsubscribe":
        connection.unsubscribeEvents?.();
        connection.unsubscribeEvents = undefined;
        return { subscribed: false };
      case "config.get":
        return this.options.config;
      case "daemon.stop":
        return { stopping: true };
      default:
        throw new ProtocolError("UNKNOWN_REQUEST", `Unknown request type: ${frame.type}`);
    }
  }

  async #requestLease(connection: Connection, value: unknown): Promise<unknown> {
    const payload = objectPayload(value);
    const requestPayload = isObject(payload.request) ? payload.request : payload;
    const osVersion = optionalString(requestPayload, "osVersion", "os");
    const request: DeviceRequest = {
      model: requiredString(requestPayload, "model", "device"),
      platform: requiredPlatform(requestPayload),
      ...(osVersion === undefined ? {} : { osVersion }),
    };
    const mode = payload.mode === "detached" ? "detached" : "held";
    const requesterId = optionalString(payload, "requesterId") ?? this.options.defaultRequesterId;
    let progressSocket: Socket | undefined = connection.socket;
    const disposeProgress = () => {
      progressSocket = undefined;
    };
    connection.progressDisposers.add(disposeProgress);
    connection.progressRequesters.add(requesterId);
    let grant;
    try {
      grant = await this.options.leaseEngine.request(request, {
        allowDownload: optionalBoolean(payload, "allowDownload") ?? false,
        mode,
        noWait: optionalBoolean(payload, "noWait") ?? false,
        onProgress: (progress) => {
          if (progressSocket !== undefined) {
            void this.#pushProgress(progressSocket, progress);
          }
        },
        requesterId,
        ...(typeof payload.timeoutMs === "number" ? { timeoutMs: payload.timeoutMs } : {}),
      });
    } finally {
      connection.progressDisposers.delete(disposeProgress);
      connection.progressRequesters.delete(requesterId);
      disposeProgress();
    }
    if (mode === "held" && (connection.closed || this.#stopping)) {
      await this.options.leaseEngine.release(grant.lease.id, "closed");
    } else if (mode === "held") {
      connection.heldLeaseIds.add(grant.lease.id);
    }
    return grant;
  }

  #list(payload: Record<string, unknown>): unknown {
    const snapshot = this.options.registry.snapshot;
    switch (payload.kind) {
      case "leases":
        return snapshot.leases;
      case "rules":
        return this.options.reaper.manualRules;
      case "devices":
      case undefined:
        return snapshot.devices;
      default:
        throw new ProtocolError("BAD_REQUEST", "list kind must be devices, leases, or rules");
    }
  }

  #status(): unknown {
    const snapshot = this.options.registry.snapshot;
    const running = this.options.leaseEngine.runningCapacity;
    const warmDevices = snapshot.devices.filter((device) => device.state === "ready");
    const capacity = Object.fromEntries(
      (["ios", "android"] as const).map((platform) => [
        platform,
        {
          limit: this.options.config.limits[platform].maxDevices,
          ...running[platform],
          warm: warmDevices.filter((device) => device.spec.platform === platform).length,
          used: snapshot.devices.filter(
            (device) => device.spec.platform === platform && device.state !== "deleted",
          ).length,
        },
      ]),
    );
    return {
      ...snapshot,
      capacity: { ...capacity, global: { ...running.global, warm: warmDevices.length } },
      health: "running",
      queueDepth: this.options.leaseEngine.queueDepth,
    };
  }

  async #pushProgress(socket: Socket, progress: LeaseProgress): Promise<void> {
    return writeFrame(socket, {
      push: "progress",
      payload: progress,
    });
  }

  async #pushEvent(socket: Socket, event: EventEnvelope): Promise<void> {
    await writeFrame(socket, { push: "event", payload: event });
  }

  async #respondError(
    socket: Socket,
    id: RequestId | null,
    code: string,
    message: string,
  ): Promise<void> {
    await writeFrame(socket, { error: { code, message }, id, ok: false });
  }

  #closeConnection(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    for (const disposeProgress of connection.progressDisposers) {
      disposeProgress();
    }
    connection.progressDisposers.clear();
    for (const requesterId of connection.progressRequesters) {
      void this.options.leaseEngine.detachQueuedProgress(requesterId);
    }
    connection.progressRequesters.clear();
    this.#connections.delete(connection);
    connection.unsubscribeEvents?.();
    connection.unsubscribeEvents = undefined;
    void this.#releaseHeld(connection).catch(() => undefined);
  }

  #releaseHeld(connection: Connection): Promise<void> {
    if (connection.releasing !== undefined) {
      return connection.releasing;
    }
    const leaseIds = [...connection.heldLeaseIds];
    connection.heldLeaseIds.clear();
    const releasing = Promise.all(
      leaseIds.map(async (leaseId) => {
        try {
          await this.options.leaseEngine.release(leaseId, "closed");
        } catch (error: unknown) {
          if (!(error instanceof UnknownLeaseError)) {
            throw error;
          }
        }
      }),
    ).then(() => undefined);
    connection.releasing = releasing;
    void releasing.then(
      () => this.#clearReleasing(connection, releasing),
      () => this.#clearReleasing(connection, releasing),
    );
    return releasing;
  }

  #clearReleasing(connection: Connection, releasing: Promise<void>): void {
    if (connection.releasing === releasing) {
      connection.releasing = undefined;
    }
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function parseRequestFrame(line: string): RequestFrame {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new ProtocolError("BAD_FRAME", "Invalid JSON frame");
  }
  const frame = objectPayload(value);
  if (
    (typeof frame.id !== "string" && typeof frame.id !== "number") ||
    typeof frame.type !== "string"
  ) {
    throw new ProtocolError(
      "BAD_FRAME",
      "Request frame requires string or number id and string type",
    );
  }
  return { id: frame.id, payload: frame.payload, type: frame.type };
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ProtocolError("BAD_REQUEST", "Payload must be an object");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, ...keys: string[]): string {
  const value = optionalString(payload, ...keys);
  if (value === undefined) {
    throw new ProtocolError("BAD_REQUEST", `Missing required string: ${keys[0]}`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function requiredNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError("BAD_REQUEST", `Missing required number: ${key}`);
  }
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ProtocolError("BAD_REQUEST", `Expected boolean: ${key}`);
  }
  return value;
}

function requiredPlatform(payload: Record<string, unknown>): "ios" | "android" {
  const platform = payload.platform;
  if (platform !== "ios" && platform !== "android") {
    throw new ProtocolError("BAD_REQUEST", "platform must be ios or android");
  }
  return platform;
}

function errorCode(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.code;
  }
  if (error instanceof NoCapacityError) {
    return "NO_CAPACITY";
  }
  if (error instanceof QueueTimeoutError) {
    return "QUEUE_TIMEOUT";
  }
  if (error instanceof RequesterAlreadyLeasedError) {
    return "REQUESTER_ALREADY_LEASED";
  }
  if (error instanceof HeldLeaseRenewalError) {
    return "HELD_LEASE_RENEWAL";
  }
  if (error instanceof NoDriverError) {
    return "NO_DRIVER";
  }
  if (error instanceof RuntimeMissingError) {
    return "RUNTIME_MISSING";
  }
  if (error instanceof UnknownModelError) {
    return "UNKNOWN_MODEL";
  }
  if (error instanceof UnknownLeaseError) {
    return "UNKNOWN_LEASE";
  }
  return "INTERNAL";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function isLiveSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function writeFrame(socket: Socket, frame: unknown): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.write(`${JSON.stringify(frame)}\n`, () => resolve());
  });
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
  );
}
