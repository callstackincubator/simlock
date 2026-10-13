/**
 * why: the core names no relay target (ADR 0026); a module's function is registered under its capability name through
 * `relayTargets`, and each uplink connection carries its own relays.
 */
import type { z } from "zod";

import {
  OPERATIONS,
  RELAY_MAX_CHUNK_BYTES,
  RELAY_MAX_HEADERS,
  RELAY_MAX_PUSH_BYTES,
  isRelayFramingHeader,
  relayHeaderPairs,
  relayHeadersSchema,
} from "../contract/index.js";
import type { Logger } from "../ports/index.js";
import { DispatchError } from "./dispatch.js";

export type RelayTarget = (
  request: Request,
  tenant: string,
  leaseId: string | undefined,
) => Promise<Response>;

export type RelayTargets = Readonly<Record<string, RelayTarget>>;

type RelayRequestInput = z.infer<(typeof OPERATIONS)["relay.request"]["input"]>;
type RelayBodyInput = z.infer<(typeof OPERATIONS)["relay.body"]["input"]>;

// why: each call resolves once the frame is on the socket, so the relay reads its target only as fast as the socket drains.
export interface RelayPush {
  head(status: number, headers: readonly (readonly [string, string])[]): Promise<void>;
  chunk(base64: string): Promise<void>;
}

const MAX_ACTIVE_RELAYS = 16;
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

interface ActiveRelay {
  readonly controller: AbortController;
  readonly feed: RelayBodyFeed | undefined;
  // why: the Request's signal follows ours through a weak reference, so a target that keeps only the signal would never see an abort once the Request is collected.
  request: Request | undefined;
}

// why: a `relay.body` call is answered once the stream has handed its chunk to the target, which is what holds the gateway's sender back.

class RelayBodyFeed {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #queue: { readonly bytes: Uint8Array; readonly handed: () => void }[] = [];
  #wake: (() => void) | undefined;
  #nextSeq = 0;
  #ended = false;
  #aborted = false;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.#queue.length === 0 && !this.#ended && !this.#aborted) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        const next = this.#queue.shift();
        if (next !== undefined) {
          controller.enqueue(next.bytes);
          next.handed();
        } else if (this.#aborted) {
          controller.error(new Error("The relay ended before its body did"));
        } else {
          controller.close();
        }
      },
    });
  }

  push(seq: number, bytes: Uint8Array): Promise<void> {
    if (this.#aborted) return Promise.resolve();
    if (this.#ended) throw new Error("A chunk arrived after the end of the body");
    if (seq !== this.#nextSeq)
      throw new Error(`Expected chunk ${String(this.#nextSeq)}, got ${String(seq)}`);
    this.#nextSeq += 1;
    return new Promise<void>((handed) => {
      this.#queue.push({ bytes, handed });
      this.#signal();
    });
  }

  end(): void {
    if (this.#aborted) return;
    if (this.#ended) throw new Error("The body already ended");
    this.#ended = true;
    this.#signal();
  }

  // why: a sender must never wait on a target that stopped reading.
  abort(): void {
    this.#aborted = true;
    for (const item of this.#queue.splice(0)) item.handed();
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

export class RelayConnection {
  readonly #active = new Map<string, ActiveRelay>();
  #closed = false;

  constructor(
    private readonly targets: RelayTargets,
    private readonly logger: Logger,
  ) {}

  async request(input: RelayRequestInput, push: RelayPush): Promise<{ readonly cancelled?: true }> {
    // why: a request parked behind the startup gate reaches here after its connection closed; running its target would answer nobody.
    if (this.#closed) return { cancelled: true };
    if (this.#active.has(input.relayId)) {
      throw new DispatchError("BAD_REQUEST", `Relay ${input.relayId} is already active`);
    }
    if (this.#active.size >= MAX_ACTIVE_RELAYS) {
      throw new DispatchError(
        "BAD_REQUEST",
        `A connection holds at most ${String(MAX_ACTIVE_RELAYS)} active relays`,
      );
    }
    const target = Object.hasOwn(this.targets, input.target)
      ? this.targets[input.target]
      : undefined;
    if (target === undefined) {
      throw new DispatchError(
        "RELAY_TARGET_MISSING",
        `No module on this worker serves ${input.target}`,
        {
          target: input.target,
        },
      );
    }
    const controller = new AbortController();
    const feed = input.hasBody ? new RelayBodyFeed() : undefined;
    const active: ActiveRelay = { controller, feed, request: undefined };
    this.#active.set(input.relayId, active);
    try {
      return await this.#run(input, target, active, push);
    } finally {
      feed?.abort();
      this.#active.delete(input.relayId);
    }
  }

  // why: a relay the worker does not hold answers `{}`; the gateway learns the outcome from `relay.request`.
  // fallow-ignore-next-line unused-class-member -- reached only through the dispatcher's session (`session.relays`), which the audit cannot follow.
  body(input: RelayBodyInput): Promise<void> {
    const relay = this.#active.get(input.relayId);
    if (relay === undefined) return Promise.resolve();
    try {
      if (relay.feed === undefined) throw new Error("The relay was opened without a body");
      if ("end" in input) {
        relay.feed.end();
        return Promise.resolve();
      }
      const bytes = Buffer.from(input.chunk, "base64");
      if (bytes.length > RELAY_MAX_CHUNK_BYTES) {
        throw new Error(`A chunk is at most ${String(RELAY_MAX_CHUNK_BYTES)} bytes`);
      }
      return relay.feed.push(input.seq, bytes);
    } catch (violation: unknown) {
      relay.controller.abort();
      throw new DispatchError(
        "BAD_REQUEST",
        violation instanceof Error ? violation.message : String(violation),
      );
    }
  }

  cancel(relayId: string): void {
    this.#active.get(relayId)?.controller.abort();
  }

  abortAll(): void {
    this.#closed = true;
    for (const relay of this.#active.values()) relay.controller.abort();
  }

  async #run(
    input: RelayRequestInput,
    target: RelayTarget,
    active: ActiveRelay,
    push: RelayPush,
  ): Promise<{ readonly cancelled?: true }> {
    const { controller, feed } = active;
    const { signal } = controller;
    const cancelled = new Promise<"cancelled">((resolve) => {
      signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    let request: Request;
    try {
      request = new Request(input.url, {
        headers: new Headers(input.headers.filter(([name]) => !isRelayFramingHeader(name))),
        method: input.method,
        signal,
        ...(feed === undefined ? {} : { body: feed.stream, duplex: "half" }),
      } as RequestInit);
    } catch (error: unknown) {
      throw new DispatchError(
        "BAD_REQUEST",
        `The relayed request cannot be built: ${describe(error)}`,
      );
    }
    active.request = request;
    const answered = target(request, input.tenant, input.leaseId).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    const first = await Promise.race([answered, cancelled]);
    if (first === "cancelled") {
      void answered
        .then((late) => ("response" in late ? late.response.body?.cancel() : undefined))
        .catch(() => undefined);
      return { cancelled: true };
    }
    if ("error" in first) {
      if (signal.aborted) return { cancelled: true };
      this.logger.error("Relay target failed", {
        message: describe(first.error),
        target: input.target,
      });
      throw new Error("The relay target failed");
    }
    return this.#respond(input, first.response, signal, push);
  }

  async #respond(
    input: RelayRequestInput,
    response: Response,
    signal: AbortSignal,
    push: RelayPush,
  ): Promise<{ readonly cancelled?: true }> {
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
      return { cancelled: true };
    }
    await push.head(response.status, headers);
    const noBody =
      input.method === "HEAD" || NO_BODY_STATUSES.has(response.status) || response.body === null;
    if (noBody) {
      void response.body?.cancel().catch(() => undefined);
      return signal.aborted ? { cancelled: true } : {};
    }
    return this.#stream(input, response.body, signal, push);
  }

  async #stream(
    input: RelayRequestInput,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    push: RelayPush,
  ): Promise<{ readonly cancelled?: true }> {
    const reader = body.getReader();
    const stop = () => void reader.cancel().catch(() => undefined);
    // why: a cancel that landed while the head was being written already fired its event, so no listener would ever stop this reader.
    if (signal.aborted) {
      stop();
      return { cancelled: true };
    }
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        const step = await reader.read();
        if (signal.aborted) return { cancelled: true };
        if (step.done) return {};
        for (let offset = 0; offset < step.value.length; offset += RELAY_MAX_PUSH_BYTES) {
          const piece = step.value.subarray(offset, offset + RELAY_MAX_PUSH_BYTES);
          await push.chunk(
            Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("base64"),
          );
          if (signal.aborted) return { cancelled: true };
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) return { cancelled: true };
      this.logger.error("Relay target's response body failed", {
        message: describe(error),
        target: input.target,
      });
      throw new Error("The relay target's response body failed");
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
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
