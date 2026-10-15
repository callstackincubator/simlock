// why: every wait of a relayed exchange is bounded (architecture rule on cross-process waits): one deadline covers the
// channel wait and the wait for the head, and an idle bound covers the response body, which may be a live stream that
// runs as long as someone reads it; the link bounds the channels open to a worker (ADR 0028).

import { isSimlockError, relayHeaderPairs, type AnySimlockError } from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import { LinkChannelError, type LinkChannel } from "../link/index.js";
import { type Clock, SystemClock, type TimerHandle } from "../ports/index.js";
import { isUplinkLost, liveClient, type WorkerDirectory } from "./fleet-ports.js";
import type { GatewayWorkerClient } from "./worker-client.js";

export interface GatewayRelayOptions {
  readonly directory: WorkerDirectory;
  readonly deadlineMs?: number;
  readonly idleMs?: number;
  readonly clock?: Clock;
}

export interface GatewayRelayCall {
  readonly target: string;
  readonly request: Request;
  readonly tenant: string;
  readonly leaseId?: string;
}

// why: agent-device's proxy allows 300 s per exchange; the rest is a margin.
const DEFAULT_DEADLINE_MS = 330_000;
// why: agent-device's proxy ends an exchange 300 s after it starts, and its RPC body may sit silent between progress
// lines for most of that; a bound at or under 300 s would cut exchanges the worker still finishes. A live stream's
// worker side already ends a capture silent for 30 s, so for a stream this only backs up a worker that hangs.
const DEFAULT_IDLE_MS = 330_000;
type RelayMethod = Parameters<GatewayWorkerClient["relayRequest"]>[0]["method"];
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

export class GatewayRelay {
  constructor(private readonly options: GatewayRelayOptions) {}

  relay(workerId: string, call: GatewayRelayCall): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const exchange = new Exchange({
        call,
        client: () => liveClient(this.options.directory.target(workerId)),
        deadlineMs: this.options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        clock: this.options.clock ?? new SystemClock(),
        idleMs: this.options.idleMs ?? DEFAULT_IDLE_MS,
        reject,
        resolve,
        workerId,
      });
      exchange.start();
    });
  }
}

interface ExchangeInit {
  readonly call: GatewayRelayCall;
  readonly client: () => GatewayWorkerClient | undefined;
  readonly deadlineMs: number;
  readonly idleMs: number;
  readonly clock: Clock;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: unknown) => void;
  readonly workerId: string;
}

class Exchange {
  readonly #relayId = crypto.randomUUID();
  readonly #opening = new AbortController();
  #client: GatewayWorkerClient | undefined;
  #channel: LinkChannel | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #ahead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  #timer: TimerHandle | undefined;
  #idleTimer: TimerHandle | undefined;
  #callerBody: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #requestSent = false;
  #cancelSent = false;
  #done = false;
  #headed = false;
  #answered = false;
  #peerAborted = false;
  #bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
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
    this.#timer = this.init.clock.setTimer(deadlineMs, () => {
      this.#fail(
        new DispatchError(
          "WORKER_UNREACHABLE",
          `worker ${workerId} did not finish the relayed request within ${String(deadlineMs)} ms`,
          { workerId },
        ),
      );
    });
    void this.#run();
  }

  async #run(): Promise<void> {
    const client = this.init.client();
    if (client === undefined) {
      this.#fail(this.#unreachable());
      return;
    }
    this.#client = client;
    let channel: LinkChannel;
    try {
      channel = await client.openChannel({ signal: this.#opening.signal });
    } catch (error: unknown) {
      this.#fail(error instanceof DispatchError ? error : this.#unreachable());
      return;
    }
    if (this.#done) {
      channel.abort();
      return;
    }
    this.#channel = channel;
    this.#reader = channel.readable.getReader();
    this.#look();
    const { request } = this.init.call;
    const body = request.body;
    this.#requestSent = true;
    client
      .relayRequest(
        {
          channel: channel.id,
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
          onRelayHead: (head) => this.#onHead(head.status, head.headers),
          onRelayInvalid: () => this.#invalid(),
        },
      )
      .then(
        (answer) => this.#onAnswer(answer),
        (error: unknown) => this.#onCallError(error),
      );
    await this.#upload(channel, body);
  }

  async #upload(channel: LinkChannel, body: ReadableStream<Uint8Array> | null): Promise<void> {
    const writer = channel.writable.getWriter();
    if (body === null) {
      await writer.close().catch(() => undefined);
      return;
    }
    const reader = body.getReader();
    this.#callerBody = reader;
    try {
      for (;;) {
        const step = await reader.read();
        if (this.#done) return;
        if (step.done) break;
        await writer.write(step.value);
      }
      await writer.close();
    } catch (error: unknown) {
      if (this.#done) return;
      if (error instanceof LinkChannelError) {
        // why: the worker stopped reading this direction, so the caller's body is no longer read.
        if (error.reason === "stopped") reader.cancel().catch(() => undefined);
        else this.#onChannelError(error);
        return;
      }
      this.#fail(error);
    }
  }

  // why: a single read is kept ahead so a channel that fails before the head is seen without anyone reading the body.
  #look(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.#ahead === undefined) {
      const read = (this.#reader as ReadableStreamDefaultReader<Uint8Array>).read();
      read.then(
        (step) => {
          if (!step.done) this.#armIdle();
        },
        (error: unknown) => this.#onChannelError(error),
      );
      this.#ahead = read;
    }
    return this.#ahead;
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
    // why: once the head is in, the body is bounded by silence, not by the deadline, so a live stream is not cut.
    if (this.#timer !== undefined) this.init.clock.cancel(this.#timer);
    this.#armIdle();
    const method = this.init.call.request.method;
    if (method === "HEAD" || NO_BODY_STATUSES.has(status)) {
      this.init.resolve(new Response(null, { headers: responseHeaders, status }));
      void this.#drain();
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
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await this.#look();
    } catch {
      return;
    }
    this.#ahead = undefined;
    if (this.#done) return;
    if (step.done) {
      controller.close();
      this.#finish();
      return;
    }
    controller.enqueue(step.value);
  }

  // why: a response with no body still ends with the channel's end, which frees the channel and its timers.
  async #drain(): Promise<void> {
    try {
      for (;;) {
        const step = await this.#look();
        this.#ahead = undefined;
        if (this.#done) return;
        if (step.done) {
          this.#finish();
          return;
        }
      }
    } catch {
      // why: a failed channel is reported by `#onChannelError`.
    }
  }

  #armIdle(): void {
    if (!this.#headed || this.#done) return;
    if (this.#idleTimer !== undefined) this.init.clock.cancel(this.#idleTimer);
    const { clock, idleMs, workerId } = this.init;
    this.#idleTimer = clock.setTimer(idleMs, () => {
      this.#fail(
        new DispatchError(
          "WORKER_UNREACHABLE",
          `worker ${workerId} sent nothing on the relayed response for ${String(idleMs)} ms`,
          { workerId },
        ),
      );
    });
  }

  #invalid(): void {
    this.#fail(
      new DispatchError("INTERNAL", `worker ${this.init.workerId} sent an invalid relay response`),
    );
  }

  #unreachable(): DispatchError {
    return new DispatchError(
      "WORKER_UNREACHABLE",
      `Worker ${this.init.workerId} is not reachable`,
      {
        workerId: this.init.workerId,
      },
    );
  }

  #onChannelError(error: unknown): void {
    if (this.#done) return;
    const { workerId } = this.init;
    if (!(error instanceof LinkChannelError)) {
      this.#fail(error);
      return;
    }
    switch (error.reason) {
      case "aborted":
        // why: the worker's `relay.request` answer says why it aborted; when none comes, the deadline ends the wait,
        // or after the head the idle bound does.
        this.#peerAborted = true;
        if (this.#answered) this.#fail(this.#endedEarly());
        return;
      case "closed":
        this.#fail(this.#unreachable());
        return;
      case "not-accepted":
        this.#fail(
          new DispatchError(
            "WORKER_UNREACHABLE",
            `worker ${workerId} did not take the relayed request within 30 s`,
            { workerId },
          ),
        );
        return;
      case "stalled":
        this.#fail(
          new DispatchError(
            "INTERNAL",
            this.#headed
              ? `the reader of worker ${workerId}'s relayed response fell behind for 60 s`
              : `worker ${workerId} did not read the relayed request body for 60 s`,
          ),
        );
        return;
      default:
        this.#invalid();
    }
  }

  #endedEarly(): DispatchError {
    const { workerId } = this.init;
    return this.#headed
      ? new DispatchError("INTERNAL", `worker ${workerId} ended the relayed response early`)
      : new DispatchError("INTERNAL", `worker ${workerId} ended the relay without a response`);
  }

  #onAnswer(answer: { readonly cancelled?: true | undefined }): void {
    if (this.#done) return;
    if (this.#peerAborted) {
      this.#fail(this.#endedEarly());
      return;
    }
    if (answer.cancelled === true || !this.#headed) {
      this.#fail(
        new DispatchError(
          "INTERNAL",
          `worker ${this.init.workerId} ended the relay without a response`,
        ),
      );
      return;
    }
    // why: the body ends at the channel's end, not at this answer, which may overtake the body's last bytes.
    this.#answered = true;
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
    this.#channel?.abort();
    this.#finish();
  }

  #fail(error: unknown): void {
    if (this.#done) return;
    this.#sendCancel();
    this.#opening.abort(error);
    this.#channel?.abort();
    if (this.#headed) this.#bodyController?.error(error);
    else this.init.reject(error);
    this.#finish();
  }

  #sendCancel(): void {
    if (!this.#requestSent || this.#cancelSent || this.#client === undefined) return;
    this.#cancelSent = true;
    this.#client.relayCancel({ relayId: this.#relayId }).catch(() => undefined);
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    if (this.#timer !== undefined) this.init.clock.cancel(this.#timer);
    if (this.#idleTimer !== undefined) this.init.clock.cancel(this.#idleTimer);
    this.init.call.request.signal.removeEventListener("abort", this.#abortListener);
    this.#callerBody?.cancel().catch(() => undefined);
  }
}
