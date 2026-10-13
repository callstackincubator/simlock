// why: every wait of a relayed exchange is bounded (architecture rule on cross-process waits): a deadline for the whole
// exchange, 4 unanswered request-body calls, 8 relays per worker and 64 MiB of response a caller has not read.

import { isSimlockError, relayHeaderPairs, type AnySimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { isUplinkLost, liveClient, type WorkerDirectory } from "./fleet-ports.js";
import type { GatewayWorkerClient } from "./worker-client.js";

export interface GatewayRelayOptions {
  readonly directory: WorkerDirectory;
  readonly deadlineMs?: number;
}

export interface GatewayRelayCall {
  readonly target: string;
  readonly request: Request;
  readonly tenant: string;
  readonly leaseId?: string;
}

// why: agent-device's proxy allows 300 s per exchange; the rest is a margin.
const DEFAULT_DEADLINE_MS = 330_000;
type RelayMethod = Parameters<GatewayWorkerClient["relayRequest"]>[0]["method"];
const MAX_RELAYS_PER_WORKER = 8;
const MAX_BODY_CALLS_UNANSWERED = 4;
const MAX_BODY_CHUNK_BYTES = 256 * 1024;
const MAX_UNREAD_BYTES = 64 * 1024 * 1024;
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export class GatewayRelay {
  readonly #slots = new Map<string, WorkerSlots>();

  constructor(private readonly options: GatewayRelayOptions) {}

  relay(workerId: string, call: GatewayRelayCall): Promise<Response> {
    let slots = this.#slots.get(workerId);
    if (slots === undefined) {
      slots = new WorkerSlots();
      this.#slots.set(workerId, slots);
    }
    return new Promise<Response>((resolve, reject) => {
      const exchange = new Exchange({
        call,
        client: () => liveClient(this.options.directory.target(workerId)),
        deadlineMs: this.options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        reject,
        resolve,
        slots,
        workerId,
      });
      exchange.start();
    });
  }
}

class WorkerSlots {
  #active = 0;
  readonly #waiters: (() => void)[] = [];

  acquire(): SlotHandle {
    if (this.#active < MAX_RELAYS_PER_WORKER) {
      this.#active += 1;
      return { granted: Promise.resolve(), release: this.#releaseOnce() };
    }
    let waiting = true;
    let grant!: () => void;
    const granted = new Promise<void>((resolve) => {
      grant = resolve;
    });
    const waiter = () => {
      waiting = false;
      grant();
    };
    this.#waiters.push(waiter);
    let released = false;
    return {
      granted,
      release: () => {
        if (released) return;
        released = true;
        if (!waiting) {
          this.#free();
          return;
        }
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        grant();
      },
    };
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#free();
    };
  }

  #free(): void {
    const next = this.#waiters.shift();
    if (next === undefined) this.#active -= 1;
    else next();
  }
}

interface SlotHandle {
  readonly granted: Promise<void>;
  readonly release: () => void;
}

interface ExchangeInit {
  readonly call: GatewayRelayCall;
  readonly client: () => GatewayWorkerClient | undefined;
  readonly deadlineMs: number;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
  readonly slots: WorkerSlots;
  readonly workerId: string;
}

class Exchange {
  readonly #relayId = crypto.randomUUID();
  #client: GatewayWorkerClient | undefined;
  #slot: SlotHandle | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #requestSent = false;
  #cancelSent = false;
  #done = false;
  #headed = false;
  #bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #wakeBody: (() => void) | undefined;
  readonly #chunks: Uint8Array[] = [];
  #unreadBytes = 0;
  #bodyEnded = false;
  readonly #abortListener = () => this.#fail(this.init.call.request.signal.reason);

  constructor(private readonly init: ExchangeInit) {}

  start(): void {
    const { call, deadlineMs, workerId } = this.init;
    const signal = call.request.signal;
    if (signal.aborted) {
      this.init.reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", this.#abortListener, { once: true });
    this.#timer = setTimeout(() => {
      this.#fail(
        new DispatchError(
          "WORKER_UNREACHABLE",
          `worker ${workerId} did not finish the relayed request within ${String(deadlineMs)} ms`,
          { workerId },
        ),
      );
    }, deadlineMs);
    void this.#run();
  }

  async #run(): Promise<void> {
    const slot = this.init.slots.acquire();
    this.#slot = slot;
    await slot.granted;
    if (this.#done) return;
    const client = this.init.client();
    if (client === undefined) {
      this.#fail(
        new DispatchError("WORKER_UNREACHABLE", `Worker ${this.init.workerId} is not reachable`, {
          workerId: this.init.workerId,
        }),
      );
      return;
    }
    this.#client = client;
    const { request } = this.init.call;
    const body = request.body;
    this.#requestSent = true;
    client
      .relayRequest(
        {
          hasBody: body !== null,
          headers: relayHeaderPairs(request.headers, { dropCredentials: true }),
          method: request.method as RelayMethod,
          relayId: this.#relayId,
          target: this.init.call.target,
          tenant: this.init.call.tenant,
          url: request.url,
          ...(this.init.call.leaseId === undefined ? {} : { leaseId: this.init.call.leaseId }),
        },
        {
          onRelayChunk: (chunk) => this.#onChunk(chunk),
          onRelayHead: (head) => this.#onHead(head.status, head.headers),
          onRelayInvalid: () => this.#invalid(),
        },
      )
      .then(
        (answer) => this.#onAnswer(answer),
        (error: unknown) => this.#onCallError(error),
      );
    if (body !== null) await this.#upload(client, body);
  }

  async #upload(client: GatewayWorkerClient, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    this.#reader = reader;
    const unanswered = new Set<Promise<void>>();
    const send = async (input: Parameters<GatewayWorkerClient["relayBody"]>[0]): Promise<void> => {
      while (unanswered.size >= MAX_BODY_CALLS_UNANSWERED) await Promise.race(unanswered);
      if (this.#done) return;
      const call: Promise<void> = client.relayBody(input).then(
        () => void unanswered.delete(call),
        (error: unknown) => {
          unanswered.delete(call);
          this.#onCallError(error);
        },
      );
      unanswered.add(call);
    };
    try {
      let seq = 0;
      for (;;) {
        while (unanswered.size >= MAX_BODY_CALLS_UNANSWERED) await Promise.race(unanswered);
        if (this.#done) return;
        const step = await reader.read();
        if (this.#done) return;
        if (step.done) break;
        for (let offset = 0; offset < step.value.length; offset += MAX_BODY_CHUNK_BYTES) {
          const piece = step.value.subarray(offset, offset + MAX_BODY_CHUNK_BYTES);
          await send({
            chunk: Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64"),
            relayId: this.#relayId,
            seq,
          });
          seq += 1;
        }
      }
      await send({ end: true, relayId: this.#relayId });
    } catch (error: unknown) {
      this.#fail(error);
    }
  }

  #onHead(status: number, headers: readonly (readonly [string, string])[]): void {
    if (this.#done) return;
    if (this.#headed) {
      this.#invalid();
      return;
    }
    const responseHeaders = new Headers();
    try {
      for (const [name, value] of headers) responseHeaders.append(name, value);
    } catch {
      // why: `Headers` refuses a value above U+00FF that the push schema lets through.
      this.#invalid();
      return;
    }
    this.#headed = true;
    const method = this.init.call.request.method;
    if (method === "HEAD" || NO_BODY_STATUSES.has(status)) {
      this.init.resolve(new Response(null, { headers: responseHeaders, status }));
      return;
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel: () => this.#abandon(),
        pull: (controller) => this.#pull(controller),
        start: (controller) => {
          this.#bodyController = controller;
        },
      },
      { highWaterMark: 0 },
    );
    this.init.resolve(new Response(stream, { headers: responseHeaders, status }));
  }

  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        this.#unreadBytes -= chunk.length;
        controller.enqueue(chunk);
        return;
      }
      if (this.#bodyEnded) {
        controller.close();
        return;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wakeBody = resolve;
      });
    }
  }

  #onChunk(chunk: string): void {
    if (this.#done) return;
    if (!this.#headed) {
      this.#invalid();
      return;
    }
    const bytes = new Uint8Array(Buffer.from(chunk, "base64"));
    this.#chunks.push(bytes);
    this.#unreadBytes += bytes.length;
    if (this.#unreadBytes > MAX_UNREAD_BYTES) {
      this.#fail(
        new DispatchError(
          "INTERNAL",
          `the reader of worker ${this.init.workerId}'s relayed response fell behind: more than 64 MiB was buffered`,
        ),
      );
      return;
    }
    this.#wake();
  }

  #invalid(): void {
    this.#fail(
      new DispatchError("INTERNAL", `worker ${this.init.workerId} sent an invalid relay response`),
    );
  }

  #onAnswer(answer: { readonly cancelled?: true | undefined }): void {
    if (this.#done) return;
    if (answer.cancelled === true || !this.#headed) {
      this.#fail(
        new DispatchError(
          "INTERNAL",
          `worker ${this.init.workerId} ended the relay without a response`,
        ),
      );
      return;
    }
    this.#bodyEnded = true;
    this.#wake();
    this.#finish();
  }

  #onCallError(error: unknown): void {
    this.#fail(isSimlockError(error) ? this.#translate(error) : error);
  }

  #translate(error: AnySimlockError): DispatchError {
    if (isUplinkLost(error)) {
      return new DispatchError("WORKER_UNREACHABLE", error.message, {
        workerId: this.init.workerId,
      });
    }
    return new DispatchError(error.code, error.message, error.details);
  }

  // why: a caller that stops reading its response is not a failure, but the worker must be told.
  #abandon(): void {
    if (this.#done) return;
    this.#sendCancel();
    this.#finish();
  }

  #fail(error: unknown): void {
    if (this.#done) return;
    this.#sendCancel();
    if (this.#headed) {
      this.#chunks.length = 0;
      this.#unreadBytes = 0;
      this.#bodyController?.error(error);
    } else this.init.reject(error);
    this.#finish();
  }

  #sendCancel(): void {
    if (!this.#requestSent || this.#cancelSent || this.#client === undefined) return;
    this.#cancelSent = true;
    this.#client.relayCancel({ relayId: this.#relayId }).catch(() => undefined);
  }

  #wake(): void {
    const wake = this.#wakeBody;
    this.#wakeBody = undefined;
    wake?.();
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.init.call.request.signal.removeEventListener("abort", this.#abortListener);
    this.#reader?.cancel().catch(() => undefined);
    this.#slot?.release();
    this.#wake();
  }
}
