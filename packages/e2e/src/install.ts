import { mayAnswerLater } from "./errors.js";
import { pause } from "./pause.js";

export function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

const TRIES = 3;
const BACKOFF_MS = 15_000;

// why: an app upload that a proxy cut off (a 524 page) reaches agent-device's client as an error with no details, so its message is all that tells it from a refused install.
const UPLOAD_CUT = /^Invalid upload response/u;

function cut(error: unknown): boolean {
  return mayAnswerLater(error) || (error instanceof Error && UPLOAD_CUT.test(error.message));
}

export async function sendAgain<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= TRIES || !cut(error)) throw error;
      await pause(BACKOFF_MS * attempt, signal);
    }
  }
}
