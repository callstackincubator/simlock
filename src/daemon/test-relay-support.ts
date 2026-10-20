import { createCipheriv, createHash, type Hash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import type { GatewayRelay } from "../gateway/index.js";
import { MemoryFilesystem, NoopLogger, SystemClock, type Logger } from "../ports/index.js";
import type { LinkChannel, LinkConnection } from "../link/index.js";
import { linkPair, TappedTransport, type LinkPair } from "../link/testing.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { RelayTarget, RelayTargets } from "./relay.js";
import type { DaemonServer } from "./server.js";
import { SimlockWire, type CallHooks, type RelayHead } from "../simlock-client/wire.js";

export const MIB = 1024 * 1024;
export const KIB = 1024;

export const adminSession: DispatchSession = {
  manageEventSubscription: () => undefined,
  principal: "test-operator",
  role: "admin",
  via: "socket",
};

async function freeLoopbackPort(): Promise<number> {
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

export async function settleWithin<T>(promise: Promise<T>, withinMs = 5_000): Promise<Settled<T>> {
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

/** why: AES in counter mode gives bytes that are random-access by offset and generated at GB/s, so a 2 GiB pattern costs seconds, not a byte loop's minutes. */
export function patternBytes(size: number, seed = 1, offset = 0): Uint8Array {
  const key = Buffer.alloc(16);
  key.writeUInt32BE(seed >>> 0, 12);
  const block = BigInt(Math.floor(offset / 16));
  const counter = Buffer.alloc(16);
  counter.writeBigUInt64BE(block >> 64n, 0);
  counter.writeBigUInt64BE(block & 0xffff_ffff_ffff_ffffn, 8);
  const cipher = createCipheriv("aes-128-ctr", key, counter);
  const skip = offset % 16;
  const out = cipher.update(Buffer.alloc(skip + size));
  return new Uint8Array(out.buffer, out.byteOffset + skip, size);
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

export async function readParts(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array[]> {
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

export interface Uplink {
  readonly wire: SimlockWire;
  readonly link: LinkConnection;
  readonly pair: LinkPair;
}

export async function openUplink(worker: DaemonServer): Promise<Uplink> {
  const pair = linkPair();
  worker.acceptUplink(pair.worker);
  const wire = new SimlockWire(pair.gateway);
  await wire.hello({ principal: "gw:test" });
  return { link: pair.gateway, pair, wire };
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
  readonly channel: LinkChannel;
  readonly result: Promise<unknown>;
  readonly heads: RelayHead[];
  readonly body: (withinMs?: number) => Promise<Settled<Uint8Array>>;
  readonly readError: () => Promise<{ readonly reason?: string; readonly ended: boolean }>;
}

export interface OpenRelayOptions {
  readonly upload?: Uint8Array;
  readonly keepOpen?: boolean;
  readonly channelName?: string | null;
}

export async function openRelay(
  uplink: Pick<Uplink, "link" | "wire">,
  input: Record<string, unknown>,
  options: OpenRelayOptions = {},
): Promise<OpenedRelay> {
  const channel = await uplink.link.openChannel({ signal: new AbortController().signal });
  const heads: RelayHead[] = [];
  const hooks: CallHooks = { onRelayHead: (head) => heads.push(head) };
  const named = options.channelName === null ? {} : { channel: options.channelName ?? channel.id };
  const result = uplink.wire.call("relay.request", { ...input, ...named }, hooks);
  result.catch(() => undefined);
  if (options.keepOpen !== true) {
    const writer = channel.writable.getWriter();
    if (options.upload !== undefined) {
      void writer
        .write(options.upload)
        .then(() => writer.close())
        .catch(() => undefined);
    } else {
      void writer.close().catch(() => undefined);
    }
  }
  const body = async (withinMs = 3_000): Promise<Settled<Uint8Array>> => {
    const read = (async () => {
      const parts = await readParts(channel.readable);
      return new Uint8Array(Buffer.concat(parts));
    })();
    return settleWithin(read, withinMs);
  };
  const readError = async (): Promise<{ reason?: string; ended: boolean }> => {
    const read = (async (): Promise<{ reason?: string; ended: boolean }> => {
      try {
        await readParts(channel.readable);
        return { ended: true };
      } catch (error: unknown) {
        return { ended: false, reason: (error as { reason?: string }).reason ?? String(error) };
      }
    })();
    return Promise.race([
      read,
      sleep(3_000).then(() => ({ ended: false, reason: "still open after 3 s" })),
    ]);
  };
  return { body, channel, heads, readError, relayId: String(input.relayId), result };
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

export interface FleetExec {
  args: string[];
  command: string;
  env: object;
}

export interface FleetContext {
  readonly daemons: DaemonServer[];
  readonly directories: string[];
  readonly target: RelayTarget;
}

export interface FleetOptions {
  readonly execCommand?: FleetExec;
  // why: a test puts a proxy between the worker and the gateway, so the worker dials the proxy.
  readonly gatewayUrl?: (gatewayPort: number) => string | Promise<string>;
}

export async function startFleet(context: FleetContext, options: FleetOptions = {}) {
  const { daemons, directories, target } = context;
  const execCommand = options.execCommand;
  const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-relay-gateway-"));
  directories.push(gatewayDirectory);
  const port = await freeLoopbackPort();
  const workerDials = (await options.gatewayUrl?.(port)) ?? `ws://127.0.0.1:${String(port)}`;
  let relay: GatewayRelay | undefined;
  const taps: TappedTransport[] = [];
  const gateway = await startDaemon({
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    role: "gateway",
    dataDirectory: gatewayDirectory,
    filesystem: new MemoryFilesystem(),
    gatewayRelay: (given) => {
      relay = given;
    },
    gatewayUplinks: (uplinks) => {
      const listen = uplinks.listen.bind(uplinks);
      uplinks.listen = (handlers) =>
        listen({
          ...handlers,
          accept: (uplink) => {
            const tap = new TappedTransport(uplink.connection);
            taps.push(tap);
            handlers.accept({ ...uplink, connection: tap });
          },
        });
    },
    logger: new NoopLogger(),
    statePath: join(gatewayDirectory, "state.json"),
    version: "1.0.0-e2e",
  });
  daemons.push(gateway);
  const { secret } = await gateway.dispatch(
    "token.create",
    { label: "worker-a", role: "worker" },
    adminSession,
  );
  const driverOptions =
    execCommand === undefined ? {} : { passthrough: () => execCommand, passthroughTools: ["adb"] };
  const worker = await startWorker(
    directories,
    daemons,
    { "agent-device": target, echo: target },
    {
      configOverrides: {
        gateway: { label: "worker-a", token: secret, url: workerDials },
      },
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          knownModels: ["Pixel-A"],
          platform: "android",
          ...driverOptions,
        } as ConstructorParameters<typeof FakeDriver>[0]),
      ],
    },
  );
  let workerId = "";
  await vi.waitFor(
    async () => {
      const { workers } = await gateway.dispatch("worker.list", {}, adminSession);
      const ready = workers.find(
        (view) => view.connection === "connected" && view.capacity && view.catalog?.length,
      );
      expect(ready).toBeDefined();
      workerId = ready?.id ?? "";
    },
    { timeout: 10_000 },
  );
  expect(relay).toBeDefined();
  return { gateway, port, relay: relay as unknown as GatewayRelay, taps, worker, workerId };
}

export interface CountingProxy {
  readonly port: number;
  readonly carried: () => { readonly up: number; readonly down: number };
  readonly reset: () => void;
  readonly stop: () => Promise<void>;
}

export function startCountingProxy(targetPort: number): Promise<CountingProxy> {
  const counts = { down: 0, up: 0 };
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.on("data", (chunk: Buffer) => {
      counts.up += chunk.length;
    });
    upstream.on("data", (chunk: Buffer) => {
      counts.down += chunk.length;
    });
    // why: pipe pauses the reader while the writer is full, so the proxy never buffers a stream.
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        carried: () => ({ down: counts.down, up: counts.up }),
        port: address.port,
        reset: () => {
          counts.down = 0;
          counts.up = 0;
        },
        stop: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const CHECKPOINT = 64 * MIB;
const checkpoints = new Map<string, Hash[]>();

function checkpointsFor(total: number, seed: number): Hash[] {
  const key = `${String(total)}:${String(seed)}`;
  const known = checkpoints.get(key);
  if (known !== undefined) return known;
  const states: Hash[] = [];
  const hash = createHash("sha256");
  for (let offset = 0; offset < total; offset += CHECKPOINT) {
    states.push(hash.copy());
    hash.update(patternBytes(Math.min(CHECKPOINT, total - offset), seed, offset));
  }
  checkpoints.set(key, states);
  return states;
}

/** why: the digest of the pattern with the chunk `[first, first + firstSize)` and the chunk `[second, second + secondSize)` exchanged, where `first + firstSize <= second`. */
export function patternDigestSwapped(
  total: number,
  seed: number,
  swap: {
    readonly first: number;
    readonly second: number;
    readonly firstSize: number;
    readonly secondSize: number;
  },
): string {
  const states = checkpointsFor(total, seed);
  const start = Math.floor(swap.first / CHECKPOINT) * CHECKPOINT;
  const hash = (states[start / CHECKPOINT] as Hash).copy();
  const feed = (from: number, to: number) => {
    for (let offset = from; offset < to; offset += MIB) {
      hash.update(patternBytes(Math.min(MIB, to - offset), seed, offset));
    }
  };
  feed(start, swap.first);
  hash.update(patternBytes(swap.secondSize, seed, swap.second));
  feed(swap.first + swap.firstSize, swap.second);
  hash.update(patternBytes(swap.firstSize, seed, swap.first));
  feed(swap.second + swap.secondSize, total);
  return hash.digest("hex");
}
