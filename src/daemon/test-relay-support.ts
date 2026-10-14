import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeDriver } from "../core/testing.js";
import {
  createConnectionPair,
  MemoryFilesystem,
  SystemClock,
  type IpcConnection,
  type Logger,
} from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { RelayTargets } from "./relay.js";
import type { DaemonServer } from "./server.js";
import { SimlockWire, type CallHooks, type RelayHead } from "../simlock-client/wire.js";

export const MIB = 1024 * 1024;
export const KIB = 1024;

export const adminSession: DispatchSession = {
  manageEventSubscription: () => undefined,
  principal: "test-operator",
  role: "admin",
};

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RecordingLogger implements Logger {
  readonly records: { readonly level: string; readonly text: string }[] = [];
  debug(message: string, fields?: Record<string, unknown>): void {
    this.#add("debug", message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.#add("info", message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.#add("warn", message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.#add("error", message, fields);
  }
  child(): Logger {
    return this;
  }
  problems(): string {
    return this.records
      .filter((record) => record.level === "warn" || record.level === "error")
      .map((record) => record.text)
      .join("\n");
  }
  #add(level: string, message: string, fields?: Record<string, unknown>): void {
    this.records.push({ level, text: `${message} ${JSON.stringify(fields ?? {})}` });
  }
}

export type Settled<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected"; readonly code?: unknown; readonly message: string }
  | { readonly state: "pending" };

export async function settle<T>(promise: Promise<T>, withinMs = 5_000): Promise<Settled<T>> {
  const outcome = promise.then(
    (value): Settled<T> => ({ state: "fulfilled", value }),
    (error: unknown): Settled<T> => ({
      state: "rejected",
      code: (error as { code?: unknown } | null)?.code,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return Promise.race([outcome, sleep(withinMs).then((): Settled<T> => ({ state: "pending" }))]);
}

export function patternBytes(size: number, seed = 1, offset = 0): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = ((offset + index) * 31 + seed * 17 + ((offset + index) >> 8)) & 0xff;
  }
  return bytes;
}

export function digestOf(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

export function patternDigest(total: number, seed: number, pieceSize = MIB): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < total; offset += pieceSize) {
    hash.update(patternBytes(Math.min(pieceSize, total - offset), seed, offset));
  }
  return hash.digest("hex");
}

export function patternStream(
  total: number,
  seed: number,
  options: {
    readonly pieceSize?: number;
    readonly delayMs?: number;
    readonly onPull?: () => void;
  } = {},
): ReadableStream<Uint8Array> {
  const pieceSize = options.pieceSize ?? MIB;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      options.onPull?.();
      if (options.delayMs !== undefined) await sleep(options.delayMs);
      if (offset >= total) {
        controller.close();
        return;
      }
      const size = Math.min(pieceSize, total - offset);
      controller.enqueue(patternBytes(size, seed, offset));
      offset += size;
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  if (stream === null) return parts;
  const reader = stream.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) return parts;
    parts.push(step.value);
  }
}

export interface WorkerFixture {
  readonly worker: DaemonServer;
  readonly logger: RecordingLogger;
  readonly directory: string;
}

export async function startWorker(
  directories: string[],
  daemons: DaemonServer[],
  relayTargets: RelayTargets,
  extra: Partial<StartDaemonOptions> = {},
): Promise<WorkerFixture> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-e2e-relay-worker-"));
  directories.push(directory);
  const logger = new RecordingLogger();
  const options: StartDaemonOptions = {
    dataDirectory: directory,
    drivers: [
      new FakeDriver({
        availableOsVersions: ["18.0"],
        clock: new SystemClock(),
        knownModels: ["Pixel-A"],
        platform: "android",
      }),
    ],
    filesystem: new MemoryFilesystem(),
    logger,
    relayTargets,
    statePath: join(directory, "state.json"),
    version: "1.0.0-e2e",
    ...extra,
  };
  const worker = await startDaemon(options);
  daemons.push(worker);
  return { directory, logger, worker };
}

export async function openUplink(
  worker: DaemonServer,
): Promise<{ readonly wire: SimlockWire; readonly gatewayEnd: IpcConnection }> {
  const [workerEnd, gatewayEnd] = createConnectionPair();
  worker.acceptUplink(workerEnd);
  const wire = new SimlockWire(gatewayEnd);
  await wire.hello({ principal: "gw:test" });
  return { gatewayEnd, wire };
}

let relaySequence = 0;
function nextRelayId(): string {
  relaySequence += 1;
  return `relay-${String(relaySequence)}`;
}

export function relayInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hasBody: false,
    headers: [["accept", "text/plain"]],
    method: "GET",
    relayId: nextRelayId(),
    target: "echo",
    tenant: "gw.g1.alice",
    url: "http://gateway.test:4321/agent-device/rpc?x=1",
    ...overrides,
  };
}

export interface OpenedRelay {
  readonly relayId: string;
  readonly result: Promise<unknown>;
  readonly heads: RelayHead[];
  readonly chunks: string[];
  readonly bytes: () => Uint8Array[];
}

export function openRelay(wire: SimlockWire, input: Record<string, unknown>): OpenedRelay {
  const heads: RelayHead[] = [];
  const chunks: string[] = [];
  const hooks: CallHooks = {
    onRelayChunk: (chunk) => chunks.push(chunk),
    onRelayHead: (head) => heads.push(head),
  };
  const result = wire.call("relay.request", input, hooks);
  result.catch(() => undefined);
  return {
    bytes: () => chunks.map((chunk) => new Uint8Array(Buffer.from(chunk, "base64"))),
    chunks,
    heads,
    relayId: String(input.relayId),
    result,
  };
}

export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export async function cleanUp(daemons: DaemonServer[], directories: string[]): Promise<void> {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
}

export function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
