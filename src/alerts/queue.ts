import type { EventEnvelope } from "../bus/index.js";
import type { AlertDestination } from "../core/index.js";
import type { Clock, Logger, TimerHandle, WebhookPoster } from "../ports/index.js";
import { errorCode } from "./error-code.js";
import { ALERT_FORMAT_REGISTRY } from "./formats/index.js";

const TRY_TIMEOUT_MS = 10_000;
const MAX_TRIES = 3;
const RETRY_WAITS_MS = [1_000, 5_000] as const;
const MAX_WAITING = 100;

interface InFlight {
  readonly envelope: EventEnvelope;
  request?: { headers: Record<string, string>; body: string };
  controller?: AbortController;
  timer?: TimerHandle;
}

interface QueueOptions {
  readonly destination: AlertDestination;
  readonly poster: WebhookPoster;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly version: string;
  workerLabel(workerId: string): string;
}

export class DestinationQueue {
  readonly #options: QueueOptions;
  readonly destination: AlertDestination;
  readonly #waiting: EventEnvelope[] = [];
  #current: InFlight | undefined;
  #stopped = false;

  constructor(options: QueueOptions) {
    this.#options = options;
    this.destination = options.destination;
  }

  // fallow-ignore-next-line unused-class-member -- called from createAlerts on array elements.
  enqueue(envelope: EventEnvelope): void {
    if (this.#stopped) return;
    if (this.#waiting.length >= MAX_WAITING) {
      const dropped = this.#waiting.shift() as EventEnvelope;
      this.#fields("warn", "Alert dropped: queue full", dropped);
    }
    this.#waiting.push(envelope);
    this.#pump();
  }

  // fallow-ignore-next-line unused-class-member -- called from createAlerts on array elements.
  stop(): number {
    this.#stopped = true;
    const discarded = this.#waiting.length + (this.#current === undefined ? 0 : 1);
    this.#waiting.length = 0;
    const current = this.#current;
    this.#current = undefined;
    if (current?.timer !== undefined) this.#options.clock.cancel(current.timer);
    current?.controller?.abort();
    return discarded;
  }

  #fields(
    level: "debug" | "warn",
    message: string,
    envelope: EventEnvelope,
    extra: Record<string, unknown> = {},
  ): void {
    this.#options.logger[level](message, {
      destination: this.#options.destination.name,
      event: envelope.event,
      eventId: envelope.id,
      ...extra,
    });
  }

  #pump(): void {
    if (this.#current !== undefined || this.#stopped) return;
    const envelope = this.#waiting.shift();
    if (envelope === undefined) return;
    const message: InFlight = { envelope };
    this.#current = message;
    // why: the bus handler only enqueues; building and the first POST happen after it returns.
    queueMicrotask(() => this.#start(message));
  }

  #start(message: InFlight): void {
    if (this.#current !== message) return;
    const { envelope } = message;
    try {
      message.request = ALERT_FORMAT_REGISTRY[this.#options.destination.format].build({
        envelope,
        destination: this.#options.destination,
        version: this.#options.version,
        workerLabel: this.#options.workerLabel,
      });
    } catch {
      this.#fields("warn", "Alert send gave up", envelope, { attempt: 1, error: "build-failed" });
      this.#finish(message);
      return;
    }
    this.#attempt(message, 1);
  }

  #finish(message: InFlight): void {
    if (this.#current !== message) return;
    this.#current = undefined;
    this.#pump();
  }

  #attempt(message: InFlight, attempt: number): void {
    const { clock, poster, destination } = this.#options;
    const request = message.request as { headers: Record<string, string>; body: string };
    const controller = new AbortController();
    message.controller = controller;
    let settled = false;

    // why: a try ends exactly once; whichever of the answer, the failure or the timeout comes
    // first wins, and a late settle of an aborted try changes nothing.
    const settle = (outcome: { status: number } | { error: string }): void => {
      if (settled || this.#current !== message) return;
      settled = true;
      if (message.timer !== undefined) clock.cancel(message.timer);
      this.#decide(message, attempt, outcome);
    };

    message.timer = clock.setTimer(TRY_TIMEOUT_MS, () => {
      if (settled || this.#current !== message) return;
      controller.abort();
      settle({ error: "timeout" });
    });

    let pending: Promise<{ status: number }>;
    try {
      pending = poster.post({
        url: destination.url,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      ({ status }) => settle({ status }),
      (error: unknown) => settle({ error: errorCode(error) }),
    );
  }

  #decide(
    message: InFlight,
    attempt: number,
    outcome: { status: number } | { error: string },
  ): void {
    const { envelope } = message;
    if ("status" in outcome && outcome.status >= 200 && outcome.status < 300) {
      this.#fields("debug", "Alert delivered", envelope, { attempt });
      this.#finish(message);
      return;
    }
    const retryable = "error" in outcome || outcome.status === 429 || outcome.status >= 500;
    if (!retryable || attempt >= MAX_TRIES) {
      this.#fields("warn", "Alert send gave up", envelope, { attempt, ...outcome });
      this.#finish(message);
      return;
    }
    message.timer = this.#options.clock.setTimer(RETRY_WAITS_MS[attempt - 1] as number, () => {
      if (this.#current === message) this.#attempt(message, attempt + 1);
    });
  }
}
