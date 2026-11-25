import { expect, vi } from "vitest";
import { LinkChannelError } from "../link/index.js";
import type { LinkChannel, LinkChannelErrorReason, LinkConnection } from "../link/index.js";
import { FakeClock, type Clock } from "../ports/index.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import { completeHello, ScriptedConnection } from "../simlock-client/test-support.js";
import type { SentFrame } from "../simlock-client/test-support.js";
import type { WorkerDirectory } from "./fleet-ports.js";
import { GatewayRelay, type TwoWayRelay } from "./index.js";
import type { GatewayWorkerClient } from "./worker-client.js";
import { errorMessage } from "../shared/index.js";

export const WORKER_ID = "wrk_a";

export const KIB = 1024;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeChannel implements LinkChannel {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly written: Uint8Array[] = [];
  readonly credit = 0;
  writableClosed = false;
  aborted = false;
  abortReason: string | undefined;
  #readController!: ReadableStreamDefaultController<Uint8Array>;
  #writeController!: WritableStreamDefaultController;

  constructor(readonly id: string) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#readController = controller;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      close: () => {
        this.writableClosed = true;
      },
      start: (controller) => {
        this.#writeController = controller;
      },
      write: (chunk) => {
        this.written.push(chunk);
      },
    });
  }

  whenCredit(): Promise<void> {
    return Promise.resolve();
  }

  abort(reason?: string): void {
    this.aborted = true;
    this.abortReason = reason;
    try {
      this.#readController.error(new LinkChannelError("aborted"));
    } catch {
      // why: the readable had already ended or failed.
    }
  }

  feed(bytes: Uint8Array): void {
    this.#readController.enqueue(bytes);
  }

  end(): void {
    this.#readController.close();
  }

  fail(reason: LinkChannelErrorReason): void {
    try {
      this.#readController.error(new LinkChannelError(reason));
    } catch {
      // why: already ended.
    }
    try {
      this.#writeController.error(new LinkChannelError(reason));
    } catch {
      // why: already closed.
    }
  }

  // why: the real channel errors its writable at once on a peer's STOP (src/link/channel.ts onStop → #failOutgoing).
  // fallow-ignore-next-line unused-class-member -- the relay tests call it on the fake channel this file builds.
  stopWriting(): void {
    this.#writeController.error(new LinkChannelError("stopped"));
  }

  failWritable(reason: LinkChannelErrorReason): void {
    this.#writeController.error(new LinkChannelError(reason));
  }
}

export class FakeLink extends ScriptedConnection implements LinkConnection {
  readonly channels: FakeChannel[] = [];
  holdOpen = false;

  openChannel(options: { readonly signal: AbortSignal }): Promise<LinkChannel> {
    if (this.holdOpen) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(options.signal.reason as Error);
        if (options.signal.aborted) fail();
        else options.signal.addEventListener("abort", fail, { once: true });
      });
    }
    const channel = new FakeChannel(`chan-${String(this.channels.length + 1)}`);
    this.channels.push(channel);
    return Promise.resolve(channel);
  }

  acceptChannel(id: string): LinkChannel {
    throw new Error(`the gateway accepts no channel: ${id}`);
  }
}

export async function setup(
  options: {
    readonly deadlineMs?: number;
    readonly holdOpen?: boolean;
    readonly idleMs?: number;
    readonly clock?: Clock;
    readonly proxyAuthHeader?: string;
  } = {},
) {
  const connection = new FakeLink();
  connection.holdOpen = options.holdOpen ?? false;
  const connecting = connectSimlockClient({ connection, credential: "secret" }, true);
  await vi.waitFor(() => expect(connection.lastSentOf("hello")).toBeDefined());
  completeHello(connection, { role: "admin" });
  const client = (await connecting) as GatewayWorkerClient;
  const directory: WorkerDirectory = {
    target: (workerId) =>
      workerId === WORKER_ID
        ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
        : undefined,
  };
  return {
    connection,
    relay: new GatewayRelay({
      directory,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.proxyAuthHeader === undefined
        ? {}
        : { proxyAuthHeader: options.proxyAuthHeader }),
    }),
  };
}

export function call(
  body?: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): { request: Request; target: string; tenant: string } {
  return {
    request: new Request("http://gateway.test:4321/agent-device/rpc", {
      method: body === undefined ? "GET" : "PUT",
      ...(body === undefined ? {} : { body, duplex: "half" }),
      ...(signal === undefined ? {} : { signal }),
    } as RequestInit),
    target: "echo",
    tenant: "gw:g1:alice",
  };
}

export async function sentFrame(connection: ScriptedConnection, type: string): Promise<SentFrame> {
  await vi.waitFor(() => expect(connection.lastSentOf(type)).toBeDefined());
  return connection.lastSentOf(type) as SentFrame;
}

export async function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ state: "fulfilled" as const, value }),
    (error: unknown) => ({
      code: (error as { code?: unknown } | null)?.code,
      message: errorMessage(error),
      state: "rejected" as const,
    }),
  );
}

export function relayIdOf(frame: SentFrame): unknown {
  return (frame.payload as { relayId?: unknown }).relayId;
}

export async function readFailure(response: Response) {
  return outcome(response.body?.getReader().read() ?? Promise.reject(new Error("no body")));
}

export async function openedChannel(connection: FakeLink): Promise<FakeChannel> {
  await vi.waitFor(() => expect(connection.channels).toHaveLength(1));
  return connection.channels[0] as FakeChannel;
}

export async function openTwoWay(signal?: AbortSignal) {
  const clock = new FakeClock();
  const { connection, relay } = await setup({ clock });
  const pending = relay.relayTwoWay(WORKER_ID, call(undefined, signal));
  const request = await sentFrame(connection, "relay.request");
  const channel = await openedChannel(connection);
  connection.push("relay-head", { headers: [], requestId: request.id, status: 200 });
  const opened = (await pending) as TwoWayRelay;
  return {
    channel,
    clock,
    connection,
    reader: opened.readable.getReader(),
    writer: opened.writable.getWriter(),
  };
}
