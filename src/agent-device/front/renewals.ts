import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
import type { Clock } from "../../ports/index.js";
import type { FrontContext } from "./context.js";

export type RenewOutcome =
  | { readonly kind: "renewed" }
  | { readonly kind: "gone" }
  | { readonly kind: "unlisted" }
  | { readonly kind: "failed"; readonly message: string };

const TICKS_PER_TTL = 3;
// why: a timer delay above this overflows and fires at once.
const LONGEST_TIMER_DELAY_MS = 2 ** 31 - 1;

export async function renewLease(
  context: FrontContext,
  leaseId: string,
  ttlMs: number,
): Promise<RenewOutcome> {
  const entry = context.map.get(leaseId);
  if (entry === undefined) return { kind: "gone" };
  const session = buildHttpSession(entry.identity);
  try {
    const { leases } = await context.dispatch("lease.list", {}, session);
    const listed = leases.find((lease) => lease.id === leaseId);
    if (listed === undefined) {
      if (context.link.stillHeld?.(leaseId) !== true) return { kind: "gone" };
      return { kind: "unlisted" };
    }
    if (context.clock.now() + ttlMs > listed.ttlDeadline) {
      await context.dispatch("lease.renew", { leaseId, ttlMs }, session);
    }
    return { kind: "renewed" };
  } catch (error) {
    if (mapError(error).code === "UNKNOWN_LEASE") return { kind: "gone" };
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

interface Running {
  calls: number;
  timer?: ReturnType<Clock["setTimer"]>;
}

export class Renewals {
  readonly #running = new Map<string, Running>();
  #disposed = false;

  constructor(private readonly clock: Clock) {}

  begin(context: FrontContext, leaseId: string, identityId: string, maxRunMs: number): () => void {
    const entry = context.map.get(leaseId);
    if (
      this.#disposed ||
      entry === undefined ||
      entry.identity.principal !== identityId ||
      entry.endedAt !== undefined
    ) {
      return () => undefined;
    }
    const running = this.#running.get(leaseId) ?? { calls: 0 };
    this.#running.set(leaseId, running);
    running.calls += 1;
    if (running.calls === 1) this.#arm(context, leaseId, running);
    let over = false;
    let limit: ReturnType<Clock["setTimer"]> | undefined;
    const end = (): void => {
      if (over) return;
      over = true;
      if (limit !== undefined) this.clock.cancel(limit);
      this.#finish(context, leaseId, running);
    };
    limit = this.clock.setTimer(Math.min(maxRunMs, LONGEST_TIMER_DELAY_MS), end);
    return end;
  }

  rearm(context: FrontContext, leaseId: string): void {
    const running = this.#running.get(leaseId);
    if (running !== undefined && !this.#disposed) this.#arm(context, leaseId, running);
  }

  cancelIfEnded(context: FrontContext, leaseId: string): void {
    const running = this.#running.get(leaseId);
    if (running !== undefined && context.map.get(leaseId)?.endedAt !== undefined) {
      this.#disarm(running);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const running of this.#running.values()) this.#disarm(running);
    this.#running.clear();
  }

  #disarm(running: Running): void {
    if (running.timer !== undefined) this.clock.cancel(running.timer);
    delete running.timer;
  }

  #arm(context: FrontContext, leaseId: string, running: Running): void {
    this.#disarm(running);
    const entry = context.map.get(leaseId);
    if (entry === undefined || entry.endedAt !== undefined) return;
    const timer = this.clock.setTimer(
      Math.min(entry.ttlMs / TICKS_PER_TTL, LONGEST_TIMER_DELAY_MS),
      () => {
        void this.#tick(context, leaseId, running, timer);
      },
    );
    running.timer = timer;
  }

  async #tick(
    context: FrontContext,
    leaseId: string,
    running: Running,
    timer: ReturnType<Clock["setTimer"]>,
  ): Promise<void> {
    if (running.timer !== timer || this.#disposed) return;
    delete running.timer;
    await this.#renewOnce(context, leaseId);
    // why: a heartbeat may have re-armed the timer while this renewal ran; that timer stands.
    if (!this.#disposed && running.timer === undefined && this.#running.get(leaseId) === running) {
      this.#arm(context, leaseId, running);
    }
  }

  async #renewOnce(context: FrontContext, leaseId: string): Promise<void> {
    const entry = context.map.get(leaseId);
    if (this.#disposed || entry === undefined || entry.endedAt !== undefined) return;
    const outcome = await renewLease(context, leaseId, entry.ttlMs);
    if (this.#disposed) return;
    if (outcome.kind === "gone") context.map.markEnded(leaseId);
    else if (outcome.kind === "unlisted") {
      context.logger.warn("the gateway's lease list left a simlock lease out; will retry", {
        leaseId,
      });
    } else if (outcome.kind === "failed") {
      context.logger.warn("agent-device front could not renew a simlock lease", {
        leaseId,
        message: outcome.message,
      });
    }
  }

  #finish(context: FrontContext, leaseId: string, running: Running): void {
    running.calls -= 1;
    if (running.calls > 0) return;
    this.#disarm(running);
    if (this.#running.get(leaseId) === running) this.#running.delete(leaseId);
    void this.#renewOnce(context, leaseId);
  }
}
