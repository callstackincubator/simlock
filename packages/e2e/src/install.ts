import type { createAgentDeviceClient } from "agent-device";

import { mayAnswerLater, messageOf, saidNothing } from "./errors.js";
import { pause } from "./pause.js";

export function limiter(
  max: number,
): <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task, signal) => {
    signal.throwIfAborted();
    if (active < max) active += 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const turn = (): void => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
        const leave = (): void => {
          waiting.splice(waiting.indexOf(turn), 1);
          reject(signal.reason);
        };
        waiting.push(turn);
        signal.addEventListener("abort", leave, { once: true });
      });
    }
    try {
      return await task(signal);
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

const TRIES = 3;
const BACKOFF_MS = 15_000;

// why: an app upload that a proxy cut off (a 524 page) reaches agent-device's client as an error with no details, so the missing simlock reason is what tells it from a refused install.
function cut(error: unknown): boolean {
  return mayAnswerLater(error) || saidNothing(error);
}

async function sendAgain<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (signal.aborted || attempt >= TRIES || !cut(error)) throw error;
      await pause(BACKOFF_MS * attempt, signal);
    }
  }
}

// why: a device whose install failed for a reason the farm did not mark as passing is worth swapping; a cut install is not, so the caller can tell the two apart.
export class DeviceSetupFailed extends Error {
  constructor(
    message: string,
    readonly deviceId: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

export interface Installation {
  readonly apps: ReturnType<typeof createAgentDeviceClient>["apps"];
  readonly platform: "ios" | "android";
  readonly deviceId: string;
  readonly limit: ReturnType<typeof limiter>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

async function installApp(
  on: Installation,
  appPath: string,
  app: string | undefined,
): Promise<void> {
  on.signal.throwIfAborted();
  const started = Date.now();
  const device = on.platform === "android" ? { serial: on.deviceId } : { udid: on.deviceId };
  try {
    await sendAgain(
      () =>
        on.limit(
          (signal) =>
            on.apps.install({
              platform: on.platform,
              ...device,
              appPath,
              ...(app === undefined ? {} : { app }),
              signal,
            }),
          on.signal,
        ),
      on.signal,
    );
  } catch (error) {
    if (on.signal.aborted || cut(error)) throw error;
    throw new DeviceSetupFailed(messageOf(error), on.deviceId, error);
  }
  on.log(`simlock: installed ${app ?? appPath} in ${String(Date.now() - started)} ms`);
}

export async function installAll(
  on: Installation,
  request: { readonly appPath?: string | undefined; readonly app?: string | undefined },
  extraApps: readonly string[],
): Promise<void> {
  if (request.appPath !== undefined) await installApp(on, request.appPath, request.app);
  for (const extra of extraApps) await installApp(on, extra, undefined);
}
