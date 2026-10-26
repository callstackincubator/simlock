/**
 * why: the core names no relay target (ADR 0026); a module's function is registered under its capability name through
 * `relayTargets`, and each uplink connection carries its own relays.
 */
import type { z } from "zod";

import {
  OPERATIONS,
  RELAY_MAX_HEADERS,
  isRelayFramingHeader,
  relayHeaderPairs,
  relayHeadersSchema,
} from "../contract/index.js";
import { LinkChannelError, type LinkChannel } from "../link/index.js";
import type { Logger } from "../ports/index.js";
import { DispatchError } from "./dispatch.js";

export type RelayTarget = (
  request: Request,
  tenant: string,
  leaseId: string | undefined,
) => Promise<Response>;

export type RelayTargets = Readonly<Record<string, RelayTarget>>;

// why: a two-way target answers a refusal before touching `pipe`, or a 2xx with no body and then uses the pipe until it ends.
export interface TwoWayPipe {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly signal: AbortSignal;
}

export type TwoWayRelayTarget = (
  request: Request,
  tenant: string,
  leaseId: string | undefined,
  pipe: TwoWayPipe,
) => Promise<Response>;

export type TwoWayRelayTargets = Readonly<Record<string, TwoWayRelayTarget>>;

type RelayRequestInput = z.infer<(typeof OPERATIONS)["relay.request"]["input"]>;

// why: the call resolves once the frame is on the socket, so the relay writes the response body only after its head.
export interface RelayPush {
  head(status: number, headers: readonly (readonly [string, string])[]): Promise<void>;
}

type RelayResult = { readonly cancelled?: true };

const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

interface ActiveRelay {
  readonly controller: AbortController;
  readonly channel: LinkChannel;
  // why: the Request's signal follows ours through a weak reference, so a target that keeps only the signal would never see an abort once the Request is collected.
  request: Request | undefined;
  // why: the first failure the channel reports decides how the call answers (ADR 0028's failure table).
  failure: unknown;
  // why: set once the target has answered; what the target has not read of the request body is dropped from then on.
  abandoned: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

// why: a two-way relay is done when the target has read the gateway's direction to its end (or stopped reading it) and has closed its own.
interface PipeEnds {
  readonly read: Promise<void>;
  readonly write: Promise<void>;
}

type TargetCall = (request: Request, pipe: TwoWayPipe | undefined) => Promise<Response>;

export class RelayConnection {
  readonly #active = new Map<string, ActiveRelay>();
  // why: an id is taken from the duplicate check until the call ends, so two lines with one id in one read cannot both run their target while the first waits for credit.
  readonly #reserved = new Set<string>();
  #closed = false;

  constructor(
    private readonly targets: RelayTargets,
    private readonly logger: Logger,
    private readonly twoWayTargets: TwoWayRelayTargets = {},
  ) {}

  // why: every way the call fails or is cancelled aborts the channel it owns; only a `{}` answer leaves it to end on its own.
  async request(
    input: RelayRequestInput,
    push: RelayPush,
    channel: LinkChannel,
  ): Promise<RelayResult> {
    try {
      const result = await this.#request(input, push, channel);
      if (result.cancelled === true) channel.abort();
      return result;
    } catch (error: unknown) {
      channel.abort();
      throw error;
    }
  }

  async #request(
    input: RelayRequestInput,
    push: RelayPush,
    channel: LinkChannel,
  ): Promise<RelayResult> {
    // why: a request parked behind the startup gate reaches here after its connection closed; running its target would answer nobody.
    if (this.#closed) return { cancelled: true };
    if (this.#reserved.has(input.relayId)) {
      throw new DispatchError("BAD_REQUEST", `Relay ${input.relayId} is already active`);
    }
    this.#reserved.add(input.relayId);
    try {
      return await this.#admitted(input, push, channel);
    } finally {
      this.#reserved.delete(input.relayId);
    }
  }

  async #admitted(
    input: RelayRequestInput,
    push: RelayPush,
    channel: LinkChannel,
  ): Promise<RelayResult> {
    const call = this.#targetCall(input);
    if (call === undefined) {
      throw new DispatchError(
        "RELAY_TARGET_MISSING",
        `No module on this worker serves ${input.target}`,
        {
          target: input.target,
        },
      );
    }
    // why: a channel that failed while the request waited for startup answers by the failure table without running its target.
    try {
      await channel.whenCredit();
    } catch (error: unknown) {
      return this.#answerFailure(error);
    }
    const controller = new AbortController();
    const active: ActiveRelay = {
      abandoned: false,
      channel,
      controller,
      failure: undefined,
      reader: undefined,
      request: undefined,
      writer: channel.writable.getWriter(),
    };
    // why: the writable errors the moment the channel fails or the peer stops this direction, so a target that never reads its body still ends with its channel.
    active.writer.closed.catch((error: unknown) => this.#note(active, error));
    controller.signal.addEventListener("abort", () => channel.abort(), { once: true });
    this.#active.set(input.relayId, active);
    try {
      return await this.#run(input, call, active, push);
    } finally {
      this.#active.delete(input.relayId);
    }
  }

  #targetCall(input: RelayRequestInput): TargetCall | undefined {
    const { leaseId, tenant } = input;
    if (input.twoWay === true) {
      const twoWay = Object.hasOwn(this.twoWayTargets, input.target)
        ? this.twoWayTargets[input.target]
        : undefined;
      return twoWay === undefined
        ? undefined
        : (request, pipe) => twoWay(request, tenant, leaseId, pipe as TwoWayPipe);
    }
    const target = Object.hasOwn(this.targets, input.target)
      ? this.targets[input.target]
      : undefined;
    return target === undefined ? undefined : (request) => target(request, tenant, leaseId);
  }

  cancel(relayId: string): void {
    this.#active.get(relayId)?.controller.abort();
  }

  abortAll(): void {
    this.#closed = true;
    for (const relay of this.#active.values()) relay.controller.abort();
  }

  #note(active: ActiveRelay, error: unknown): void {
    if (active.failure !== undefined || active.controller.signal.aborted) return;
    active.failure = error;
    active.controller.abort();
  }

  // why: a peer that broke a link rule is the one failure the worker reports to its caller; every other reason ends the call as a cancel.
  #answerFailure(error: unknown): RelayResult {
    if (error instanceof LinkChannelError && error.reason === "invalid") {
      throw new DispatchError(
        "BAD_REQUEST",
        `The relay's channel broke a link rule: ${error.message}`,
      );
    }
    return { cancelled: true };
  }

  #finished(active: ActiveRelay): RelayResult {
    return active.failure === undefined ? { cancelled: true } : this.#answerFailure(active.failure);
  }

  #requestBody(active: ActiveRelay): ReadableStream<Uint8Array> {
    const reader = active.channel.readable.getReader();
    active.reader = reader;
    return new ReadableStream<Uint8Array>(
      {
        cancel: () => reader.cancel().catch(() => undefined),
        pull: async (controller) => {
          try {
            const step = await reader.read();
            if (active.abandoned) {
              controller.error(new Error("The relay answered before its request body ended"));
            } else if (step.done) controller.close();
            else controller.enqueue(step.value);
          } catch (error: unknown) {
            this.#note(active, error);
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 },
    );
  }

  // why: the target's end of both directions; every end it reaches (or gives up on) is recorded in `ends`.
  #pipe(active: ActiveRelay): { readonly pipe: TwoWayPipe; readonly ends: PipeEnds } {
    const reader = active.channel.readable.getReader();
    active.reader = reader;
    let readEnded!: () => void;
    let writeEnded!: () => void;
    const ends: PipeEnds = {
      read: new Promise<void>((resolve) => {
        readEnded = resolve;
      }),
      write: new Promise<void>((resolve) => {
        writeEnded = resolve;
      }),
    };
    const readable = new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          readEnded();
          return reader.cancel().catch(() => undefined);
        },
        pull: async (controller) => {
          try {
            const step = await reader.read();
            if (step.done) {
              controller.close();
              readEnded();
            } else controller.enqueue(step.value);
          } catch (error: unknown) {
            this.#note(active, error);
            controller.error(error);
          }
        },
      },
      { highWaterMark: 0 },
    );
    const writable = new WritableStream<Uint8Array>({
      abort: (reason) => active.writer.abort(reason).catch(() => undefined),
      close: async () => {
        await active.writer.close();
        writeEnded();
      },
      write: (chunk) => active.writer.write(chunk),
    });
    return { ends, pipe: { readable, signal: active.controller.signal, writable } };
  }

  async #run(
    input: RelayRequestInput,
    target: TargetCall,
    active: ActiveRelay,
    push: RelayPush,
  ): Promise<RelayResult> {
    const { controller } = active;
    const { signal } = controller;
    const cancelled = new Promise<"cancelled">((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    const twoWay = input.twoWay === true ? this.#pipe(active) : undefined;
    const request = this.#buildRequest(input, active, twoWay !== undefined);
    active.request = request;
    const answered = target(request, twoWay?.pipe).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const first = await Promise.race([answered, cancelled]);
    if (first === "cancelled") {
      void answered
        .then((late) => ("response" in late ? late.response.body?.cancel() : undefined))
        .catch(() => undefined);
      return this.#finished(active);
    }
    if ("error" in first) {
      if (signal.aborted) return this.#finished(active);
      this.logger.error("Relay target failed", {
        message: describe(first.error),
        target: input.target,
      });
      throw new Error("The relay target failed");
    }
    const piped = twoWay !== undefined && isSuccess(first.response.status);
    // why: the target has answered, so the unread rest of the request body is stopped on the channel; a two-way relay that was accepted keeps reading it.
    if (!piped) {
      active.abandoned = true;
      void active.reader?.cancel().catch(() => undefined);
    }
    return this.#respond(input, first.response, active, push, piped ? twoWay.ends : undefined);
  }

  #buildRequest(input: RelayRequestInput, active: ActiveRelay, twoWay: boolean): Request {
    try {
      const body = input.hasBody ? this.#requestBody(active) : undefined;
      // why: a relay with no body reads nothing, so the peer is told to stop that direction at once; a two-way relay reads it through its pipe.
      if (body === undefined && !twoWay) {
        void active.channel.readable.cancel().catch(() => undefined);
      }
      return new Request(input.url, {
        headers: new Headers(input.headers.filter(([name]) => !isRelayFramingHeader(name))),
        method: input.method,
        signal: active.controller.signal,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit);
    } catch (error: unknown) {
      throw new DispatchError(
        "BAD_REQUEST",
        `The relayed request cannot be built: ${describe(error)}`,
      );
    }
  }

  async #respond(
    input: RelayRequestInput,
    response: Response,
    active: ActiveRelay,
    push: RelayPush,
    ends: PipeEnds | undefined,
  ): Promise<RelayResult> {
    const { signal } = active.controller;
    const headers = relayHeaderPairs(response.headers, { dropCredentials: false });
    const broken = headerViolation(headers);
    if (broken !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      this.logger.error("Relay target answered with headers out of bounds", {
        bound: broken,
        target: input.target,
      });
      throw new Error("The relay target answered with headers out of bounds");
    }
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      return this.#finished(active);
    }
    try {
      await push.head(response.status, headers);
    } catch (error: unknown) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (ends !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      return this.#bothEnded(active, ends);
    }
    const { writer } = active;
    const noBody =
      input.method === "HEAD" || NO_BODY_STATUSES.has(response.status) || response.body === null;
    if (noBody) {
      void response.body?.cancel().catch(() => undefined);
      return this.#close(active, writer);
    }
    return this.#stream(input, response.body, active, writer);
  }

  async #bothEnded(active: ActiveRelay, ends: PipeEnds): Promise<RelayResult> {
    const { signal } = active.controller;
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const both = Promise.all([ends.read, ends.write]).then(() => "ended" as const);
    const outcome = await Promise.race([both, aborted]);
    return outcome === "ended" && !signal.aborted ? {} : this.#finished(active);
  }

  async #close(
    active: ActiveRelay,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<RelayResult> {
    try {
      await writer.close();
    } catch (error: unknown) {
      this.#note(active, error);
      return this.#finished(active);
    }
    return active.controller.signal.aborted ? this.#finished(active) : {};
  }

  async #stream(
    input: RelayRequestInput,
    body: ReadableStream<Uint8Array>,
    active: ActiveRelay,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<RelayResult> {
    const { signal } = active.controller;
    const reader = body.getReader();
    const stop = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      for (;;) {
        const step = await reader.read();
        if (signal.aborted) return this.#finished(active);
        if (step.done) break;
        try {
          await writer.write(step.value);
        } catch (error: unknown) {
          this.#note(active, error);
          return this.#finished(active);
        }
        if (signal.aborted) return this.#finished(active);
      }
    } catch (error: unknown) {
      if (signal.aborted) return this.#finished(active);
      this.logger.error("Relay target's response body failed", {
        message: describe(error),
        target: input.target,
      });
      throw new Error("The relay target's response body failed");
    } finally {
      signal.removeEventListener("abort", stop);
    }
    return this.#close(active, writer);
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function headerViolation(headers: readonly (readonly [string, string])[]): string | undefined {
  if (headers.length > RELAY_MAX_HEADERS) {
    return `at most ${String(RELAY_MAX_HEADERS)} headers, got ${String(headers.length)}`;
  }
  const parsed = relayHeadersSchema.safeParse(headers);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  return `header ${issue?.path.join(".") ?? ""} breaks its bound`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
