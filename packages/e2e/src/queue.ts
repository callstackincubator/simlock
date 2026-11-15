import { randomBytes } from "node:crypto";

import { mayAnswerLater } from "./errors.js";
import { pause } from "./pause.js";

const PAUSE_MS = 10_000;
const PAUSE_JITTER_MS = 5_000;

export interface Ask<Lease> {
  readonly platform: string;
  readonly queueMs: number;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  allocate(leaseId: string, signal: AbortSignal): Promise<Lease>;
  release(leaseId: string): Promise<unknown>;
}

type Attempt<Lease> = { lease: Lease } | { retry: true };

export async function allocateQueued<Lease>(ask: Ask<Lease>): Promise<Lease> {
  const deadline = Date.now() + ask.queueMs;
  const minutes = Math.max(1, Math.round(ask.queueMs / 60_000));
  const noDevice = (cause?: unknown): Error =>
    new Error(`simlock: no free ${ask.platform} device on the farm within ${String(minutes)} min`, {
      cause,
    });
  let announced = false;
  for (;;) {
    ask.signal.throwIfAborted();
    const attempt = await tryOnce(ask, deadline, noDevice);
    if ("lease" in attempt) return attempt.lease;
    if (!announced) {
      announced = true;
      ask.log(`simlock: no free ${ask.platform} device on the farm; waiting for one`);
    }
    await pause(PAUSE_MS + Math.floor(Math.random() * PAUSE_JITTER_MS), ask.signal);
    if (Date.now() >= deadline) throw noDevice();
  }
}

async function tryOnce<Lease>(
  ask: Ask<Lease>,
  deadline: number,
  noDevice: (cause?: unknown) => Error,
): Promise<Attempt<Lease>> {
  const leaseId = randomBytes(16).toString("hex");
  const timeUp = new AbortController();
  const timer = setTimeout(
    () => {
      timeUp.abort();
    },
    Math.max(0, deadline - Date.now()),
  );
  const giveBack = (): Promise<unknown> => ask.release(leaseId).catch(() => undefined);
  try {
    return { lease: await ask.allocate(leaseId, AbortSignal.any([ask.signal, timeUp.signal])) };
  } catch (error) {
    if (ask.signal.aborted) {
      await giveBack();
      throw ask.signal.reason;
    }
    if (timeUp.signal.aborted) {
      await giveBack();
      throw noDevice(error);
    }
    if (!mayAnswerLater(error)) throw error;
    await giveBack();
    if (Date.now() >= deadline) throw noDevice(error);
    return { retry: true };
  } finally {
    clearTimeout(timer);
  }
}
